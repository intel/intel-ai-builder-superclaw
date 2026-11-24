"""Shared, dependency-light primitives used by BOTH protection backends.

Kept import-cheap on purpose: nothing here pulls the ML stack (numpy /
spacy / onnxruntime), so the file backend and the service layer can import
it without paying for the text pipeline's heavy dependencies.

  - errors:     ServiceError hierarchy + the structured HTTP error envelope
  - bucketize:  financial-amount magnitude bucketization
  - validators: value validators, span patterns, and the canonical
                category vocabulary shared across file + text detection
"""

__version__ = "0.1.0"
