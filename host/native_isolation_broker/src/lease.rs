use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LeaseError {
    AlreadyActive,
    NotActive,
    LeaseMismatch,
    Expired,
}

#[derive(Debug)]
enum State {
    Idle,
    Active { lease_id: String, deadline: Instant },
}

#[derive(Debug)]
pub struct LeaseMachine {
    state: State,
}

impl LeaseMachine {
    pub const fn new() -> Self {
        Self { state: State::Idle }
    }

    pub fn acquire(
        &mut self,
        lease_id: String,
        timeout: Duration,
        now: Instant,
    ) -> Result<(), LeaseError> {
        if matches!(self.state, State::Active { .. }) {
            return Err(LeaseError::AlreadyActive);
        }
        self.state = State::Active {
            lease_id,
            deadline: now + timeout,
        };
        Ok(())
    }

    pub fn renew(
        &mut self,
        lease_id: &str,
        timeout: Duration,
        now: Instant,
    ) -> Result<(), LeaseError> {
        if self.expire_if_due(now) {
            return Err(LeaseError::Expired);
        }
        match &mut self.state {
            State::Idle => Err(LeaseError::NotActive),
            State::Active {
                lease_id: active,
                deadline,
            } if active == lease_id => {
                *deadline = now + timeout;
                Ok(())
            }
            State::Active { .. } => Err(LeaseError::LeaseMismatch),
        }
    }

    pub fn release(&mut self, lease_id: &str, now: Instant) -> Result<(), LeaseError> {
        if self.expire_if_due(now) {
            return Err(LeaseError::Expired);
        }
        match &self.state {
            State::Idle => Err(LeaseError::NotActive),
            State::Active {
                lease_id: active, ..
            } if active == lease_id => {
                self.state = State::Idle;
                Ok(())
            }
            State::Active { .. } => Err(LeaseError::LeaseMismatch),
        }
    }

    pub const fn deadline(&self) -> Option<Instant> {
        match &self.state {
            State::Idle => None,
            State::Active { deadline, .. } => Some(*deadline),
        }
    }

    pub fn expire_if_due(&mut self, now: Instant) -> bool {
        let expired = matches!(
            &self.state,
            State::Active { deadline, .. } if *deadline <= now
        );
        if expired {
            self.state = State::Idle;
        }
        expired
    }

    pub fn is_active(&self) -> bool {
        matches!(self.state, State::Active { .. })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acquire_renew_release_transitions_are_strict() {
        let now = Instant::now();
        let mut leases = LeaseMachine::new();
        assert!(!leases.is_active());

        leases
            .acquire("lease-a".to_owned(), Duration::from_secs(1), now)
            .expect("idle lease should acquire");
        assert!(leases.is_active());
        assert_eq!(
            leases.acquire("lease-b".to_owned(), Duration::from_secs(1), now),
            Err(LeaseError::AlreadyActive)
        );
        assert_eq!(
            leases.renew("lease-b", Duration::from_secs(1), now),
            Err(LeaseError::LeaseMismatch)
        );

        leases
            .renew("lease-a", Duration::from_secs(2), now)
            .expect("matching lease should renew");
        assert_eq!(leases.deadline(), Some(now + Duration::from_secs(2)));
        assert_eq!(
            leases.release("lease-b", now),
            Err(LeaseError::LeaseMismatch)
        );
        leases
            .release("lease-a", now)
            .expect("matching lease should release");
        assert!(!leases.is_active());
        assert_eq!(leases.release("lease-a", now), Err(LeaseError::NotActive));
    }

    #[test]
    fn lease_expires_at_deadline() {
        let now = Instant::now();
        let mut leases = LeaseMachine::new();
        leases
            .acquire("lease-a".to_owned(), Duration::from_millis(500), now)
            .expect("idle lease should acquire");

        assert!(!leases.expire_if_due(now + Duration::from_millis(499)));
        assert!(leases.expire_if_due(now + Duration::from_millis(500)));
        assert!(!leases.is_active());
    }

    #[test]
    fn renew_rejects_at_and_after_deadline() {
        let now = Instant::now();
        for elapsed in [500, 501] {
            let mut leases = LeaseMachine::new();
            leases
                .acquire("lease-a".to_owned(), Duration::from_millis(500), now)
                .expect("idle lease should acquire");

            assert_eq!(
                leases.renew(
                    "lease-a",
                    Duration::from_secs(1),
                    now + Duration::from_millis(elapsed),
                ),
                Err(LeaseError::Expired)
            );
            assert!(!leases.is_active());
        }
    }

    #[test]
    fn release_rejects_expired_lease() {
        let now = Instant::now();
        let mut leases = LeaseMachine::new();
        leases
            .acquire("lease-a".to_owned(), Duration::from_millis(500), now)
            .expect("idle lease should acquire");

        assert_eq!(
            leases.release("lease-a", now + Duration::from_millis(500)),
            Err(LeaseError::Expired)
        );
        assert!(!leases.is_active());
    }
}
