use super::ValidatedStartRequest;
use std::fmt;

impl fmt::Debug for ValidatedStartRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ValidatedStartRequest")
            .field("request", &self.request)
            .field("paths", &self.paths)
            .field(
                "scalar_placeholders",
                &self.scalars.keys().collect::<Vec<_>>(),
            )
            .finish()
    }
}
