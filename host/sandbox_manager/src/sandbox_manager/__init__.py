"""SuperClaw Sandbox Manager.

A Windows sidecar service that manages the Windows-native sandbox backend
lifecycle: payload verification, role bring-up through the isolation broker,
and OWT token issuance.

It runs as a ServiceHub sub-service exposing an unauthenticated HTTP API
under ``/sandbox-manager/v1`` (health, version, shutdown, sandbox
provisions/actions, operations polling, system status, workspace cleanup).
ServiceHub spawns the process with a fixed ``--port`` and probes
``/sandbox-manager/v1/health`` for readiness.
"""

__version__ = "2.0.0"
