use super::*;

#[test]
fn the_runner_environment_names_nothing_that_belongs_to_the_owner_account() {
    let environment = resolve_cross_account_environment(
        current_process_environment()
            .expect("the environment should be readable")
            .into_iter(),
        &[],
    )
    .expect("the base environment should resolve");
    let names: Vec<&str> = environment.iter().map(|(name, _)| name.as_str()).collect();
    assert!(names.contains(&"SYSTEMROOT"), "{names:?}");
    for excluded in crate::launch_environment::PER_ACCOUNT_ENVIRONMENT {
        assert!(
            !names.contains(excluded),
            "{excluded} describes the owner and must not cross the hop: {names:?}"
        );
    }
}
