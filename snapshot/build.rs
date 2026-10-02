//! Records the resolved perpl-sdk version and git revision from Cargo.lock, so
//! every snapshot names the exact SDK that produced it.

use std::fs;

fn main() {
    println!("cargo::rerun-if-changed=Cargo.lock");
    let lock = fs::read_to_string("Cargo.lock").unwrap_or_default();
    let (mut version, mut rev) = ("unknown".to_string(), String::new());
    let mut in_sdk = false;
    for line in lock.lines() {
        if line == "[[package]]" {
            in_sdk = false;
        } else if line == "name = \"perpl-sdk\"" {
            in_sdk = true;
        } else if in_sdk && let Some(v) = line.strip_prefix("version = ") {
            version = v.trim_matches('"').to_string();
        } else if in_sdk && let Some(src) = line.strip_prefix("source = ") {
            rev = src
                .trim_matches('"')
                .rsplit('#')
                .next()
                .unwrap_or_default()
                .chars()
                .take(12)
                .collect();
        }
    }
    println!("cargo::rustc-env=PERPL_SDK_VERSION={version}");
    println!("cargo::rustc-env=PERPL_SDK_REV={rev}");
}
