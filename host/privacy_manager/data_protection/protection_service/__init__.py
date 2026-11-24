"""HTTP service: redact files + sanitize text + restore placeholders.

Two PII pipelines, one HTTP service:

  - File redact (always available): mask tabular CSV/XLSX/Parquet,
    return a registry of placeholder -> real value. No models needed.
  - Text sanitize (optional): mask free-form text via NER + regex.
    Loads OpenVINO + spaCy at startup.

Both share /v1/restore.
"""

__version__ = "0.1.0"
