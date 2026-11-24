//! `awk.exe` for the native payload shell: runs the `goawk.exe` beside it with `-N raw` first.
//!
//! GoAWK translates `\n` to `\r\n` on Windows by default (`-N smart`), whether the output is a
//! terminal, a pipe or a file. BusyBox awk, and every other tool in the payload shell, writes `\n`,
//! so `awk '{print $1}' | xargs rm` or `[ "$(awk ...)" = name ]` would carry a stray `\r`. A caller's
//! own `-N` comes later on the command line and wins.
//!
//! GoAWK also expands wildcards in its file operands and `-f` files on Windows, where a POSIX awk
//! takes what the shell passed literally: `awk '{print}' 'a[1].txt'` would read `a1.txt`. Go's glob
//! has no escape on Windows, so the shim puts each metacharacter in a one-character class first.

use std::env;
use std::ffi::{OsStr, OsString};
use std::path::Path;
use std::process::{exit, Command};

const GOAWK: &str = "goawk.exe";

/// GoAWK's options that take the next argument as their value (`-E` and `-f` are handled apart).
const OPTIONS_WITH_VALUE: [&str; 9] = [
    "-covermode",
    "-coverprofile",
    "-cpuprofile",
    "-memprofile",
    "-F",
    "-v",
    "-i",
    "-o",
    "-N",
];

fn goawk_command(directory: &Path, args: impl IntoIterator<Item = OsString>) -> Command {
    let mut command = Command::new(directory.join(GOAWK));
    command.arg("-N").arg("raw").args(literal_operands(args.into_iter().collect()));
    command
}

/// `arg` with `*`, `?` and `[` made literal for Go's `filepath.Glob`. A name that is not UTF-8 is left alone.
fn literal_name(arg: &OsStr) -> OsString {
    let Some(text) = arg.to_str() else {
        return arg.to_owned();
    };
    let mut escaped = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '*' | '?' | '[' => {
                escaped.push('[');
                escaped.push(c);
                escaped.push(']');
            }
            _ => escaped.push(c),
        }
    }
    escaped.into()
}

/// `var=value` operands are assignments, which GoAWK takes as text.
fn is_assignment(text: &str) -> bool {
    match text.split_once('=') {
        Some((name, _)) => {
            let mut chars = name.chars();
            matches!(chars.next(), Some(c) if c == '_' || c.is_ascii_alphabetic())
                && chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
        }
        None => false,
    }
}

/// Makes the arguments GoAWK globs - its input files and `-f`/`-E` program files - literal, following
/// the option parsing in GoAWK 1.32.0's `main`. The program text, option values and assignments pass
/// unchanged.
fn literal_operands(args: Vec<OsString>) -> Vec<OsString> {
    let mut out = Vec::with_capacity(args.len());
    let mut program_file = false;
    let mut allow_assignments = true;
    let mut i = 0;
    while i < args.len() {
        let Some(text) = args[i].to_str() else { break };
        if text == "--" {
            out.push(args[i].clone());
            i += 1;
            break;
        }
        if text == "-" || !text.starts_with('-') {
            break;
        }
        if text == "-f" || text == "-E" {
            program_file = true;
            out.push(args[i].clone());
            if let Some(file) = args.get(i + 1) {
                out.push(literal_name(file));
            }
            i += 2;
            if text == "-E" {
                allow_assignments = false;
                break;
            }
        } else if OPTIONS_WITH_VALUE.contains(&text) {
            out.extend(args[i..args.len().min(i + 2)].iter().cloned());
            i += 2;
        } else if let Some(file) = text.strip_prefix("-f").or_else(|| text.strip_prefix("-E")) {
            program_file = true;
            let mut joined = OsString::from(&text[..2]);
            joined.push(literal_name(OsStr::new(file)));
            out.push(joined);
            i += 1;
            if text.starts_with("-E") {
                allow_assignments = false;
                break;
            }
        } else {
            out.push(args[i].clone());
            i += 1;
        }
    }
    for (position, arg) in args.iter().enumerate().skip(i) {
        let is_program = !program_file && position == i;
        match arg.to_str() {
            Some(text) if !is_program && !(allow_assignments && is_assignment(text)) => {
                out.push(literal_name(arg))
            }
            _ => out.push(arg.clone()),
        }
    }
    out
}

fn main() {
    let directory = match env::current_exe() {
        Ok(path) => path.parent().map(Path::to_path_buf).unwrap_or_default(),
        Err(error) => {
            eprintln!("awk: cannot locate itself: {error}");
            exit(127);
        }
    };
    match goawk_command(&directory, env::args_os().skip(1)).status() {
        Ok(status) => exit(status.code().unwrap_or(1)),
        Err(error) => {
            eprintln!("awk: cannot run {GOAWK}: {error}");
            exit(127);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_newlines_come_first_and_the_callers_arguments_follow_unchanged() {
        let command = goawk_command(
            Path::new("shell"),
            ["-F", ",", "{print $1}", "a b.csv"].map(OsString::from),
        );
        assert_eq!(command.get_program(), Path::new("shell").join(GOAWK).as_os_str());
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(args, ["-N", "raw", "-F", ",", "{print $1}", "a b.csv"]);
    }

    fn literal(args: &[&str]) -> Vec<String> {
        let args = args.iter().map(OsString::from).collect();
        literal_operands(args)
            .into_iter()
            .map(|arg| arg.into_string().unwrap())
            .collect()
    }

    #[test]
    fn input_files_are_made_literal_but_the_program_and_option_values_are_not() {
        assert_eq!(
            literal(&["-F", "*", "-v", "x=a*", "$1*2", "a[1].txt", "b?.txt", "y=c*", "-"]),
            ["-F", "*", "-v", "x=a*", "$1*2", "a[[]1].txt", "b[?].txt", "y=c*", "-"],
        );
        assert_eq!(literal(&["-F,", "{print}", "*.csv"]), ["-F,", "{print}", "[*].csv"]);
        assert_eq!(
            literal(&["-N", "raw", "BEGIN { print 2*3 }", "a[1].txt"]),
            ["-N", "raw", "BEGIN { print 2*3 }", "a[[]1].txt"],
        );
    }

    #[test]
    fn program_files_and_every_operand_are_made_literal_when_a_program_file_is_given() {
        assert_eq!(
            literal(&["-f", "p[1].awk", "-fq*.awk", "in?.txt"]),
            ["-f", "p[[]1].awk", "-fq[*].awk", "in[?].txt"],
        );
        assert_eq!(
            literal(&["-E", "p*.awk", "a*", "x=b[1].txt"]),
            ["-E", "p[*].awk", "a[*]", "x=b[[]1].txt"],
        );
    }

    #[test]
    fn everything_after_double_dash_is_an_operand_and_the_first_is_the_program() {
        assert_eq!(literal(&["--", "{print}", "a*"]), ["--", "{print}", "a[*]"]);
    }
}
