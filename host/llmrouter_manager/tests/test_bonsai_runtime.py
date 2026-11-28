"""Regression checks for the experimental Bonsai runtime; no live server needed."""
import copy
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from llmrouter_manager.local import paths
from llmrouter_manager.local.booster import LocalLLMBooster, LocalUnsupported
from llmrouter_manager.local.hardware import HardwareInfo, VIDEO_CONTROLLER_PROBE_FAILED
from llmrouter_manager.local.policy import available_chat_tiers, targets_discrete_gpu
from llmrouter_manager.local.registry import load_builtin_registry
from llmrouter_manager.local.supervisor import RouterSupervisor, SupervisorError
from llmrouter_manager.routing.policy.prompt_transform import apply_qwen_system_compat


class BonsaiRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.registry = load_builtin_registry()
        self.bonsai = next(m for m in self.registry.models.values() if m.id == 'bonsai-2.5-27b')
        self.hardware = HardwareInfo(('NVIDIA GeForce RTX 3080 Ti',), 16, 1600)
        self.env = patch.dict(os.environ, {}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_catalog_integrity_and_bundle_reference(self):
        self.assertEqual(self.bonsai.default_ctx, 98304)
        self.assertEqual(len(self.bonsai.sha256), 64)
        self.assertEqual(self.bonsai.size_bytes, 6232818944)
        source = Path(__file__).resolve().parents[1] / 'src/llmrouter_manager/data/bundles.builtin.json'
        bundles = json.loads(source.read_text())['bundles']
        bundle = next(b for b in bundles if b['chat_model_id'] == self.bonsai.id)
        self.assertEqual(bundle['compatible_product_profiles'], ['standard'])

    def test_only_validated_adapter_is_eligible(self):
        self.assertIn(self.bonsai, available_chat_tiers(self.registry, self.hardware))
        for hardware in [HardwareInfo(('NVIDIA RTX 4090',), 64, 6400),
                         HardwareInfo(('NVIDIA RTX 3080 Ti',), 8, 1600),
                         HardwareInfo((), 16, 1600)]:
            with self.subTest(hardware=hardware):
                self.assertNotIn(self.bonsai, available_chat_tiers(self.registry, hardware))

    def test_gpu_probe_failure_does_not_select_discrete_tuning(self):
        hw = HardwareInfo(self.hardware.igpu_names, 16, 1600, (VIDEO_CONTROLLER_PROBE_FAILED,))
        self.assertFalse(targets_discrete_gpu(self.bonsai, hw))

    def test_bonsai_tuning_preserves_gpu_headroom(self):
        tuned = LocalLLMBooster().tune(self.hardware, self.bonsai)
        self.assertEqual((tuned.ctx_size, tuned.parallel, tuned.batch, tuned.ubatch), (98304, 1, 512, 256))
        self.assertEqual(tuned.cache_ram_mib, 0)
        self.assertFalse(tuned.kv_unified)
        self.assertIsInstance(LocalLLMBooster().tune(self.hardware, self.bonsai, free_gpu_mib=1024), LocalUnsupported)

    def test_existing_b70_and_embedding_tuning_unchanged(self):
        qwen = next(m for m in self.registry.models.values() if m.id == 'qwen3.8-27b')
        hw = HardwareInfo(('Intel Arc Pro B70',), 64, 6400)
        self.assertEqual(LocalLLMBooster().tune(hw, qwen).ctx_size, 262144)
        embedding = next(m for m in self.registry.models.values() if m.role == 'embedding')
        self.assertIsNone(LocalLLMBooster().tune(self.hardware, embedding).ctx_size)

    def test_runtime_override_fails_closed_and_falls_back_only_when_unset(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with patch.dict(os.environ, {'LRM_INFERENCE_DIR': str(root)}):
                with self.assertRaises(FileNotFoundError): paths.llama_server_exe()
                (root / 'llama-server.exe').touch()
                self.assertEqual(paths.llama_server_exe(), root / 'llama-server.exe')
            with patch.dict(os.environ, {'LRM_INFERENCE_DIR': 'relative/runtime'}):
                with self.assertRaises(FileNotFoundError): paths.candidate_inference_dirs()
            self.assertTrue(all(p.name == 'llama-win-sycl' for p in paths.candidate_inference_dirs()))

    def supervisor(self):
        router = object.__new__(RouterSupervisor)
        router._cfg = SimpleNamespace(models_dir=Path('models'))
        router._hardware = self.hardware
        router._device_listing = [('CUDA1', 'NVIDIA GeForce RTX 3080 Ti')]
        router._main_gpu_index = 1
        router._read_store_ctx_override = lambda: None
        return router

    def test_cuda_launch_flags_and_device_pin(self):
        router = self.supervisor()
        opts = router._chat_section_options(self.bonsai, LocalLLMBooster().tune(self.hardware, self.bonsai))
        self.assertNotIn('no-mmap', opts)
        for key, value in {'load-mode':'mmap', 'main-gpu':'1', 'c':'98304', 'parallel':'1',
                           'cache-type-k':'q4_0', 'cache-type-v':'q4_0', 'spec-type':'draft-mtp',
                           'spec-draft-n-max':'3', 'reasoning':'on', 'n-predict':'8192'}.items():
            self.assertEqual(opts[key], value, key)

    def test_unknown_device_is_rejected(self):
        router = self.supervisor()
        router._main_gpu_index = None
        with self.assertRaises(SupervisorError):router._chat_section_options(self.bonsai, None)

    def test_existing_sycl_model_keeps_no_mmap(self):
        router = self.supervisor()
        qwen = next(m for m in self.registry.models.values() if m.id == 'qwen3.5-4b')
        router._apply_draft_model = lambda *args: None
        opts = router._chat_section_options(qwen, None)
        self.assertIn('no-mmap', opts)
        self.assertNotIn('load-mode', opts)

    def test_bonsai_system_normalization_preserves_user_and_tool_messages(self):
        body = {'messages':[{'role':'system','content':'first'}, {'role':'user','content':'task'},
                            {'role':'system','content':'second'}, {'role':'tool','content':'result'}]}
        original = copy.deepcopy(body)
        self.assertTrue(apply_qwen_system_compat(body, self.bonsai.id))
        self.assertEqual(body['messages'][0]['content'], 'first\n\nsecond')
        self.assertEqual(body['messages'][1:], [original['messages'][1], original['messages'][3]])
        self.assertFalse(apply_qwen_system_compat(original, 'unrelated-model'))


if __name__ == '__main__':unittest.main()
