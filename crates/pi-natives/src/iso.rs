//! napi shim for the `pi-iso` PAL.
//!
//! Mirrors [`pi_iso::IsolationBackend`] across the FFI boundary:
//!
//! - `iso_resolve(preferred?)` — let the PAL pick the best backend (or honour a
//!   hint) and report any fallback to the caller.
//! - `iso_start(kind?, lower, merged)` / `iso_stop(kind?, merged)` — sync
//!   syscalls wrapped in `spawn_blocking` so the JS side gets a normal Promise.
//!
//! `IsoError::Unavailable` is serialised with the `ISO_UNAVAILABLE:`
//! prefix so TS callers can distinguish "this backend isn't installed"
//! from a hard failure.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use pi_iso::{BackendKind, IsoError, IsolationBackend};

use crate::js;

const ISO_UNAVAILABLE_PREFIX: &str = "ISO_UNAVAILABLE:";
const ISO_UNAVAILABLE_WITH_LEADING_SPACE: &str = " ISO_UNAVAILABLE:";

/// Isolation backend identifier. Numeric so the JS side can `switch` on
/// the enum without string comparisons.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[napi]
pub enum IsoBackendKind {
	Apfs              = 0,
	Btrfs             = 1,
	Zfs               = 2,
	LinuxReflink      = 3,
	Overlayfs         = 4,
	WindowsBlockClone = 5,
	Projfs            = 6,
	Rcopy             = 7,
}

/// Outcome of [`iso_resolve`].
#[napi(object)]
pub struct IsoResolveResult {
	/// Backend that will actually be tried first.
	pub kind:       IsoBackendKind,
	/// Host-available backends in retry order, starting with `kind`.
	pub candidates: Vec<IsoBackendKind>,
	/// True when the resolver fell back from `preferred` (or from the
	/// first automatic candidate) to a different backend.
	pub fell_back:  bool,
	/// Human-readable reason for the fallback, if any.
	pub reason:     Option<String>,
}

/// Pick the best backend available right now. `preferred` is treated as
/// a hint — see [`pi_iso::resolve`] for the exact priority rules.
#[napi]
pub fn iso_resolve(preferred: Option<IsoBackendKind>) -> IsoResolveResult {
	let resolution = pi_iso::resolve(preferred.map(from_napi_kind));
	IsoResolveResult {
		kind:       to_napi_kind(resolution.kind),
		candidates: resolution
			.candidates
			.into_iter()
			.map(to_napi_kind)
			.collect(),
		fell_back:  resolution.fell_back,
		reason:     resolution.reason,
	}
}

/// Materialise `merged` as a writable view of `lower` using the requested
/// backend. `kind` defaults to the native backend.
#[napi]
pub async fn iso_start(kind: Option<IsoBackendKind>, lower: String, merged: String) -> Result<()> {
	let resolved = kind.map_or_else(BackendKind::native, from_napi_kind);
	let lower_path = std::path::PathBuf::from(lower);
	let merged_path = std::path::PathBuf::from(merged);
	tokio::task::spawn_blocking(move || pi_iso::backend(resolved).start(&lower_path, &merged_path))
		.await
		.map_err(|err| Error::from_reason(format!("iso_start join: {err}")))?
		.map_err(to_napi_error)
}

/// Tear down a previously started backend at `merged`.
#[napi]
pub async fn iso_stop(kind: Option<IsoBackendKind>, merged: String) -> Result<()> {
	let resolved = kind.map_or_else(BackendKind::native, from_napi_kind);
	let merged_path = std::path::PathBuf::from(merged);
	tokio::task::spawn_blocking(move || pi_iso::backend(resolved).stop(&merged_path))
		.await
		.map_err(|err| Error::from_reason(format!("iso_stop join: {err}")))?
		.map_err(to_napi_error)
}

/// True if `message` is an error message produced by [`IsoError::Unavailable`].
/// Use this to distinguish "this backend isn't installed" from a hard
/// failure when handling caught errors on the JS side.
#[napi]
pub fn iso_is_unavailable_error(message: napi::JsString) -> Result<bool> {
	let message = js::utf8(message)?;
	Ok(message.starts_with(ISO_UNAVAILABLE_PREFIX)
		|| message.contains(ISO_UNAVAILABLE_WITH_LEADING_SPACE))
}

pub(crate) const fn to_napi_kind(kind: BackendKind) -> IsoBackendKind {
	match kind {
		BackendKind::Apfs => IsoBackendKind::Apfs,
		BackendKind::Btrfs => IsoBackendKind::Btrfs,
		BackendKind::Zfs => IsoBackendKind::Zfs,
		BackendKind::LinuxReflink => IsoBackendKind::LinuxReflink,
		BackendKind::Overlayfs => IsoBackendKind::Overlayfs,
		BackendKind::WindowsBlockClone => IsoBackendKind::WindowsBlockClone,
		BackendKind::Projfs => IsoBackendKind::Projfs,
		BackendKind::Rcopy => IsoBackendKind::Rcopy,
	}
}

pub(crate) const fn from_napi_kind(kind: IsoBackendKind) -> BackendKind {
	match kind {
		IsoBackendKind::Apfs => BackendKind::Apfs,
		IsoBackendKind::Btrfs => BackendKind::Btrfs,
		IsoBackendKind::Zfs => BackendKind::Zfs,
		IsoBackendKind::LinuxReflink => BackendKind::LinuxReflink,
		IsoBackendKind::Overlayfs => BackendKind::Overlayfs,
		IsoBackendKind::WindowsBlockClone => BackendKind::WindowsBlockClone,
		IsoBackendKind::Projfs => BackendKind::Projfs,
		IsoBackendKind::Rcopy => BackendKind::Rcopy,
	}
}

fn to_napi_error(err: IsoError) -> Error {
	match err {
		IsoError::Unavailable(msg) => Error::from_reason(format!("{ISO_UNAVAILABLE_PREFIX} {msg}")),
		IsoError::Other(msg) => Error::from_reason(msg),
	}
}

#[allow(dead_code, reason = "compile-time check that the trait stays dyn-compatible")]
fn _assert_backend_object_safe() {
	fn assert_object_safe(_: &dyn IsolationBackend) {}
	let backend = pi_iso::default_backend();
	assert_object_safe(backend);
}
