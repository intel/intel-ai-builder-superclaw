"""SuperClaw ASR Manager -- native-host Parakeet TDT 0.6B v2 int8 speech-to-text.

An ``on_demand`` ServiceHub child: the process is started by the hub on the first
proxied request to ``/speech-to-text/*`` and the ~630 MB model is downloaded only
after the user consents, then unloaded again after an idle stretch. Nothing about
the audio leaves the machine.
"""

__version__ = "0.1.0"
