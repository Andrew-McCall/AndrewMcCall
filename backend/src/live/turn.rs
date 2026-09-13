//! Time-limited TURN credentials.
//!
//! coturn's `use-auth-secret` mode takes no user list: a credential is a
//! username of `<expiry>:<who>` and a password that is the HMAC-SHA1 of that
//! username under a secret both ends share. Anyone holding the secret can mint
//! one, and the relay accepts it until it expires.
//!
//! The alternative — a fixed username and password in the config — is one leak
//! away from being an open relay on someone else's bandwidth, and rotating it
//! means editing the server. These expire on their own.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use hmac::{Hmac, Mac};
use sha1::Sha1;

/// Builds the username and password for a credential valid until `expires_at`
/// (a Unix timestamp).
pub fn credential(secret: &str, who: &str, expires_at: i64) -> (String, String) {
    let username = format!("{expires_at}:{who}");

    let mut mac = Hmac::<Sha1>::new_from_slice(secret.as_bytes())
        .expect("hmac accepts a key of any length");
    mac.update(username.as_bytes());

    let password = STANDARD.encode(mac.finalize().into_bytes());
    (username, password)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_username_carries_its_own_expiry() {
        let (username, _) = credential("s3cr3t", "someone", 1_700_000_000);

        assert_eq!(username, "1700000000:someone");
    }

    #[test]
    fn the_password_is_the_hmac_sha1_of_the_username() {
        // Computed independently (python hmac/sha1/base64) rather than from
        // this implementation, so the test can disagree with the code.
        let (_, password) = credential(
            "s3cr3t",
            "11111111-1111-1111-1111-111111111111",
            1_700_000_000,
        );

        assert_eq!(password, "iQhY5y3hYWvh9bBBwhuV4+LAn0s=");
    }
}
