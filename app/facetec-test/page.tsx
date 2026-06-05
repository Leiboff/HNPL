'use client';

import { useEffect, useState } from 'react';

declare global {
  interface Window {
    FaceTecSDK: any;
  }
}

const DEVICE_KEY_IDENTIFIER      = 'ddWlAnek8ShiYmtD4E0GPTjpi6OQhtLA';
const FACETEC_BASE_URL           = 'https://api.facetec.com/api/v3.1/biometrics';

const PUBLIC_FACE_SCAN_ENCRYPTION_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA5PxZ3DLj+zP6T6HFgzzk
M77LdzP3fojBoLasw7EfzvLMnJNUlyRb5m8e5QyyJxI+wRjsALHvFgLzGwxM8ehz
DqqBZed+f4w33GgQXFZOS4AOvyPbALgCYoLehigLAbbCNTkeY5RDcmmSI/sbp+s6
mAiAKKvCdIqe17bltZ/rfEoL3gPKEfLXeN549LTj3XBp0hvG4loQ6eC1E1tRzSkf
GJD4GIVvR+j12gXAaftj3ahfYxioBH7F7HQxzmWkwDyn3bqU54eaiB7f0ftsPpWM
ceUaqkL2DZUvgN0efEJjnWy5y1/Gkq5GGWCROI9XG/SwXJ30BbVUehTbVcD70+ZF
8QIDAQAB
-----END PUBLIC KEY-----`;

// ── SDK init status ───────────────────────────────────────────────────────────

type SdkStatus =
  | { kind: 'loading' }
  | { kind: 'ready'; version: string }
  | { kind: 'failed'; version: string; sdkStatus: string }
  | { kind: 'error'; message: string; sdkStatus: string };

// ── Liveness scan result ──────────────────────────────────────────────────────

type ScanResult =
  | { kind: 'idle' }
  | { kind: 'scanning' }
  | { kind: 'proven' }
  | { kind: 'not_proven' }
  | { kind: 'cancelled' }
  | { kind: 'scan_error'; message: string };

// ── FaceScan processor ────────────────────────────────────────────────────────

function createProcessor(onDone: (result: ScanResult) => void) {
  let latestSessionResult: any   = null;
  let wasProcessedSuccessfully   = false;

  return {
    processSessionResultWhileFaceTecSDKWaits(
      sessionResult: any,
      faceScanResultCallback: any,
    ) {
      latestSessionResult = sessionResult;

      const sdk = window.FaceTecSDK;

      if (
        sessionResult.status !==
        sdk.FaceTecSessionStatus.SessionCompletedSuccessfully
      ) {
        faceScanResultCallback.cancel();
        return;
      }

      const body = JSON.stringify({
        faceScan:                  sessionResult.faceScan,
        auditTrailImage:           sessionResult.auditTrail[0],
        lowQualityAuditTrailImage: sessionResult.lowQualityAuditTrail[0],
        sessionId:                 sessionResult.sessionId,
      });

      const userAgent = sdk.createFaceTecAPIUserAgentString(sessionResult.sessionId);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${FACETEC_BASE_URL}/liveness-3d`);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.setRequestHeader('X-Device-Key', DEVICE_KEY_IDENTIFIER);
      xhr.setRequestHeader('X-User-Agent', userAgent);

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          faceScanResultCallback.uploadProgress(event.loaded / event.total);
        }
      };

      xhr.onreadystatechange = () => {
        if (xhr.readyState !== XMLHttpRequest.DONE) return;
        try {
          const json = JSON.parse(xhr.responseText);

          if (json.wasProcessed === true && json.error === false) {
            wasProcessedSuccessfully = true;
            faceScanResultCallback.proceedToNextStep(json.scanResultBlob);
          } else {
            faceScanResultCallback.cancel();
          }
        } catch {
          faceScanResultCallback.cancel();
        }
      };

      xhr.onerror = () => {
        faceScanResultCallback.cancel();
      };

      xhr.send(body);
    },

    onFaceTecSDKCompletelyDone() {
      const { FaceTecSessionStatus } = window.FaceTecSDK;
      const status = latestSessionResult?.status;

      if (
        status === FaceTecSessionStatus.SessionCompletedSuccessfully &&
        wasProcessedSuccessfully
      ) {
        onDone({ kind: 'proven' });
      } else if (
        status === FaceTecSessionStatus.UserCancelled ||
        status === FaceTecSessionStatus.UserCancelledFromNewUserGuidance ||
        status === FaceTecSessionStatus.UserCancelledFromRetryGuidance
      ) {
        onDone({ kind: 'cancelled' });
      } else {
        onDone({ kind: 'not_proven' });
      }
    },
  };
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function FaceTecTestPage() {
  const [sdkStatus,  setSdkStatus]  = useState<SdkStatus>({ kind: 'loading' });
  const [scanResult, setScanResult] = useState<ScanResult>({ kind: 'idle' });

  useEffect(() => {
    const script = document.createElement('script');
    script.src   = '/facetec/FaceTecSDK.js/FaceTecSDK.js';
    script.async = true;

    script.onload = () => {
      try {
        const sdk = window.FaceTecSDK;
        let version: string;
        try {
          version = sdk.version() || '(unknown)';
        } catch {
          version = '(unknown)';
        }

        sdk.setResourceDirectory('/facetec/FaceTecSDK.js/resources');
        sdk.setImagesDirectory('/facetec/FaceTec_images');

        sdk.initializeInDevelopmentMode(
          DEVICE_KEY_IDENTIFIER,
          PUBLIC_FACE_SCAN_ENCRYPTION_KEY,
          (success: boolean) => {
            const sdkStatusStr: string = sdk.getStatus?.() ?? '(unavailable)';
            if (success) {
              setSdkStatus({ kind: 'ready', version });
            } else {
              setSdkStatus({ kind: 'failed', version, sdkStatus: sdkStatusStr });
            }
          },
        );
      } catch (err) {
        const message    = err instanceof Error ? err.message : String(err);
        const sdkStatusStr: string = window.FaceTecSDK?.getStatus?.() ?? '(unavailable)';
        setSdkStatus({ kind: 'error', message, sdkStatus: sdkStatusStr });
      }
    };

    script.onerror = () => {
      setSdkStatus({
        kind:      'error',
        message:   'Failed to load FaceTecSDK.js script.',
        sdkStatus: '(unavailable)',
      });
    };

    document.body.appendChild(script);
    return () => { document.body.removeChild(script); };
  }, []);

  function startScan() {
    setScanResult({ kind: 'scanning' });

    // Step A — fetch a session token first; the camera will not open without one
    const tokenXhr = new XMLHttpRequest();
    tokenXhr.open('GET', `${FACETEC_BASE_URL}/session-token`);
    tokenXhr.setRequestHeader('X-Device-Key', DEVICE_KEY_IDENTIFIER);

    tokenXhr.onreadystatechange = () => {
      if (tokenXhr.readyState !== XMLHttpRequest.DONE) return;
      try {
        const json         = JSON.parse(tokenXhr.responseText);
        const sessionToken = json.sessionToken;
        if (typeof sessionToken !== 'string') {
          setScanResult({ kind: 'scan_error', message: 'Could not get session token' });
          return;
        }
        // Step B — create the processor and start the session with the token
        const processor = createProcessor((result) => setScanResult(result));
        new window.FaceTecSDK.FaceTecSession(processor, sessionToken);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setScanResult({ kind: 'scan_error', message });
      }
    };

    tokenXhr.onerror = () => {
      setScanResult({ kind: 'scan_error', message: 'Session token request failed' });
    };

    tokenXhr.send();
  }

  const sdkReady = sdkStatus.kind === 'ready';

  return (
    <div style={{ fontFamily: 'sans-serif', padding: '3rem', maxWidth: 640 }}>
      <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '1.5rem' }}>
        FaceTec SDK Initialization Test
      </h1>

      {/* ── SDK status ── */}
      {sdkStatus.kind === 'loading' && (
        <p style={{ fontSize: '1.25rem', color: '#555' }}>Loading SDK…</p>
      )}

      {sdkStatus.kind === 'ready' && (
        <>
          <p style={{ fontSize: '1.5rem', fontWeight: 600, color: '#16a34a' }}>
            ✅ FaceTec is ready!
          </p>
          <p style={{ marginTop: '0.75rem', color: '#555' }}>
            SDK version: <strong>{sdkStatus.version}</strong>
          </p>
        </>
      )}

      {sdkStatus.kind === 'failed' && (
        <>
          <p style={{ fontSize: '1.5rem', fontWeight: 600, color: '#dc2626' }}>
            ❌ FaceTec failed to initialize
          </p>
          <p style={{ marginTop: '0.75rem', color: '#555' }}>
            SDK version: <strong>{sdkStatus.version}</strong>
          </p>
          <p style={{ marginTop: '0.5rem', color: '#555' }}>
            SDK status: <strong>{sdkStatus.sdkStatus}</strong>
          </p>
        </>
      )}

      {sdkStatus.kind === 'error' && (
        <>
          <p style={{ fontSize: '1.5rem', fontWeight: 600, color: '#dc2626' }}>
            ❌ Error: {sdkStatus.message}
          </p>
          <p style={{ marginTop: '0.75rem', color: '#555' }}>
            SDK status: <strong>{sdkStatus.sdkStatus}</strong>
          </p>
        </>
      )}

      {/* ── Scan button ── */}
      {sdkReady && (
        <div style={{ marginTop: '2rem' }}>
          <button
            onClick={startScan}
            disabled={scanResult.kind === 'scanning'}
            style={{
              padding:         '0.75rem 1.75rem',
              fontSize:        '1rem',
              fontWeight:      600,
              color:           '#fff',
              backgroundColor: scanResult.kind === 'scanning' ? '#93c5fd' : '#0F4C75',
              border:          'none',
              borderRadius:    '0.75rem',
              cursor:          scanResult.kind === 'scanning' ? 'not-allowed' : 'pointer',
              transition:      'background-color 0.2s',
            }}
          >
            {scanResult.kind === 'scanning' ? 'Scanning…' : 'Start Face Scan'}
          </button>
        </div>
      )}

      {/* ── Scan result ── */}
      {scanResult.kind === 'proven' && (
        <p style={{ marginTop: '1.5rem', fontSize: '1.5rem', fontWeight: 600, color: '#16a34a' }}>
          ✅ Liveness PROVEN — real live person
        </p>
      )}

      {scanResult.kind === 'not_proven' && (
        <p style={{ marginTop: '1.5rem', fontSize: '1.5rem', fontWeight: 600, color: '#dc2626' }}>
          ❌ Liveness NOT proven
        </p>
      )}

      {scanResult.kind === 'cancelled' && (
        <p style={{ marginTop: '1.5rem', fontSize: '1.5rem', fontWeight: 600, color: '#6b7280' }}>
          ℹ️ Scan cancelled
        </p>
      )}

      {scanResult.kind === 'scan_error' && (
        <p style={{ marginTop: '1.5rem', fontSize: '1.5rem', fontWeight: 600, color: '#dc2626' }}>
          ❌ Error: {scanResult.message}
        </p>
      )}
    </div>
  );
}
