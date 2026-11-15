//! Persistencia del refresh token en el Administrador de credenciales de Windows.
//!
//! - Persistencia `Local` (el valor por defecto del crate es `Enterprise`, que
//!   viaja con el perfil itinerante; no lo queremos).
//! - Se guarda con `set_secret` en bytes UTF-8 (`set_password` usa UTF-16 y
//!   reduce a la mitad la capacidad útil).
//! - Límite del blob: 2560 bytes. Si se supera, error claro; no se trocea.

use std::collections::HashMap;

use keyring_core::Entry;
use keyring_core::api::CredentialStoreApi;
use windows_native_keyring_store::Store;

use crate::error::{AuthError, Result};

/// `CRED_MAX_CREDENTIAL_BLOB_SIZE` de wincred.h (5 * 512).
pub const MAX_SECRET_BYTES: usize = 2560;
/// Nombre de servicio de las credenciales de producción.
pub const SERVICE: &str = "JarWis";

fn entry(service: &str, user: &str) -> Result<Entry> {
    let store = Store::new()?;
    let mods = HashMap::from([("persistence", "Local")]);
    Ok(store.build(service, user, Some(&mods))?)
}

pub(crate) fn save(service: &str, user: &str, secret: &str) -> Result<()> {
    let bytes = secret.as_bytes();
    if bytes.len() > MAX_SECRET_BYTES {
        return Err(AuthError::TokenTooLarge { len: bytes.len(), max: MAX_SECRET_BYTES });
    }
    entry(service, user)?.set_secret(bytes)?;
    Ok(())
}

/// `Ok(None)` si no hay credencial.
pub(crate) fn load(service: &str, user: &str) -> Result<Option<String>> {
    match entry(service, user)?.get_secret() {
        Ok(b) => String::from_utf8(b)
            .map(Some)
            .map_err(|_| AuthError::Keyring("el secreto guardado está dañado")),
        Err(keyring_core::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Devuelve `true` si existía y se borró.
pub(crate) fn delete(service: &str, user: &str) -> Result<bool> {
    match entry(service, user)?.delete_credential() {
        Ok(()) => Ok(true),
        Err(keyring_core::Error::NoEntry) => Ok(false),
        Err(e) => Err(e.into()),
    }
}

/// Tipo de persistencia de la credencial guardada ("Local", "Enterprise", "Session").
#[cfg(test)]
pub(crate) fn persistence(service: &str, user: &str) -> Result<String> {
    Ok(entry(service, user)?
        .get_attributes()?
        .remove("persistence")
        .unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Ida y vuelta real contra el Administrador de credenciales (servicio de prueba).
    #[test]
    #[ignore = "escribe en el Administrador de credenciales de Windows"]
    fn credential_manager_roundtrip_local() {
        let (svc, user) = ("JarWis-test", "roundtrip");
        let secret = "valor-de-prueba-no-secreto-ñ";
        save(svc, user, secret).unwrap();
        assert_eq!(load(svc, user).unwrap().as_deref(), Some(secret));
        assert_eq!(persistence(svc, user).unwrap(), "Local");
        // Sobrescribir (rotación del refresh token).
        save(svc, user, "segundo-valor").unwrap();
        assert_eq!(load(svc, user).unwrap().as_deref(), Some("segundo-valor"));
        assert!(delete(svc, user).unwrap());
        assert_eq!(load(svc, user).unwrap(), None);
        assert!(!delete(svc, user).unwrap());
    }

    #[test]
    #[ignore = "escribe en el Administrador de credenciales de Windows"]
    fn rejects_oversized_secret() {
        let big = "x".repeat(MAX_SECRET_BYTES + 1);
        let err = save("JarWis-test", "oversized", &big).unwrap_err();
        assert!(matches!(err, AuthError::TokenTooLarge { len: 2561, max: 2560 }));
        assert!(!err.to_string().contains("xxxx"));
        // Exactamente el límite sí cabe.
        save("JarWis-test", "oversized", &"y".repeat(MAX_SECRET_BYTES)).unwrap();
        assert!(delete("JarWis-test", "oversized").unwrap());
    }
}
