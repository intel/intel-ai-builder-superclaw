use std::process::ExitCode;

fn main() -> ExitCode {
    match native_isolation_broker::run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!(
                "{{\"ok\":false,\"phase\":\"broker_exit\",\"error_code\":\"{}\"}}",
                native_isolation_broker::error_code(&error)
            );
            ExitCode::FAILURE
        }
    }
}
