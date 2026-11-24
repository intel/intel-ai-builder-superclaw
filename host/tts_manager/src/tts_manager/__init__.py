"""SuperClaw TTS Manager service.

Native Windows-host Kokoro-82M narration service. Runs synthesis on the host
CPU (onnxruntime, no torch). Host synthesis measures RTF ~0.35. Registered as a ServiceHub child under proxy prefix /tts-narration.
"""

__version__ = "0.1.0"
