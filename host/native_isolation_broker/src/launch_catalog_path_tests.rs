use super::path_is_at_or_under;

#[test]
fn path_ancestry_compares_components() {
    assert!(path_is_at_or_under(r"C:\payload", r"c:\PAYLOAD\isolation"));
    assert!(!path_is_at_or_under(r"C:\payload", r"D:\other\isolation"));
    assert!(!path_is_at_or_under(
        r"C:\payload",
        r"C:\payload-other\isolation"
    ));
}
