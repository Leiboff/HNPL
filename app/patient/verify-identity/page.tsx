'use client';

import { useEffect, useState } from 'react';
import { markIdentityVerified } from './actions';

// ── FaceTec config ────────────────────────────────────────────────────────────

declare global {
  interface Window { FaceTecSDK: any; }
}

const DEVICE_KEY_IDENTIFIER = 'ddWlAnek8ShiYmtD4E0GPTjpi6OQhtLA';
const FACETEC_BASE_URL      = 'https://api.facetec.com/api/v3.1/biometrics';

const PUBLIC_FACE_SCAN_ENCRYPTION_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA5PxZ3DLj+zP6T6HFgzzk
M77LdzP3fojBoLasw7EfzvLMnJNUlyRb5m8e5QyyJxI+wRjsALHvFgLzGwxM8ehz
DqqBZed+f4w33GgQXFZOS4AOvyPbALgCYoLehigLAbbCNTkeY5RDcmmSI/sbp+s6
mAiAKKvCdIqe17bltZ/rfEoL3gPKEfLXeN549LTj3XBp0hvG4loQ6eC1E1tRzSkf
GJD4GIVvR+j12gXAaftj3ahfYxioBH7F7HQxzmWkwDyn3bqU54eaiB7f0ftsPpWM
ceUaqkL2DZUvgN0efEJjnWy5y1/Gkq5GGWCROI9XG/SwXJ30BbVUehTbVcD70+ZF
8QIDAQAB
-----END PUBLIC KEY-----`;

// ── Types ─────────────────────────────────────────────────────────────────────

type ScanState = 'idle' | 'scanning' | 'proven' | 'failed' | 'cancelled';

// ── Liveness scan ─────────────────────────────────────────────────────────────

function runLivenessScan(onDone: (state: 'proven' | 'failed' | 'cancelled') => void) {
  const tokenXhr = new XMLHttpRequest();
  tokenXhr.open('GET', `${FACETEC_BASE_URL}/session-token`);
  tokenXhr.setRequestHeader('X-Device-Key', DEVICE_KEY_IDENTIFIER);

  tokenXhr.onreadystatechange = () => {
    if (tokenXhr.readyState !== XMLHttpRequest.DONE) return;
    try {
      const json         = JSON.parse(tokenXhr.responseText);
      const sessionToken = json.sessionToken;
      if (typeof sessionToken !== 'string') { onDone('failed'); return; }

      let latestSessionResult: any = null;
      let wasProcessedSuccessfully = false;

      const processor = {
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

          const userAgent = sdk.createFaceTecAPIUserAgentString(
            sessionResult.sessionId,
          );

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
              const apiJson = JSON.parse(xhr.responseText);

              if (apiJson.wasProcessed === true && apiJson.error === false) {
                wasProcessedSuccessfully = true;
                faceScanResultCallback.proceedToNextStep(apiJson.scanResultBlob);
              } else {
                faceScanResultCallback.cancel();
              }
            } catch {
              faceScanResultCallback.cancel();
            }
          };

          xhr.onerror = () => { faceScanResultCallback.cancel(); };
          xhr.send(body);
        },

        onFaceTecSDKCompletelyDone() {
          const { FaceTecSessionStatus } = window.FaceTecSDK;
          const status = latestSessionResult?.status;

          if (
            status === FaceTecSessionStatus.SessionCompletedSuccessfully &&
            wasProcessedSuccessfully
          ) {
            onDone('proven');
          } else if (
            status === FaceTecSessionStatus.UserCancelled ||
            status === FaceTecSessionStatus.UserCancelledFromNewUserGuidance ||
            status === FaceTecSessionStatus.UserCancelledFromRetryGuidance
          ) {
            onDone('cancelled');
          } else {
            onDone('failed');
          }
        },
      };

      new window.FaceTecSDK.FaceTecSession(processor, sessionToken);
    } catch {
      onDone('failed');
    }
  };

  tokenXhr.onerror = () => { onDone('failed'); };
  tokenXhr.send();
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function VerifyIdentityPage() {
  const [sdkReady,  setSdkReady]  = useState(false);
  const [scanState, setScanState] = useState<ScanState>('idle');

  // ── DEV bypass state ──────────────────────────────────────────────────────────
  const [devState, setDevState] = useState<'idle' | 'loading' | 'verified' | 'error'>('idle');
  const [devError, setDevError] = useState<string | null>(null);

  async function handleDevBypass() {
    setDevState('loading');
    const result = await markIdentityVerified();
    if (result.error) {
      setDevError(result.error);
      setDevState('error');
    } else {
      setDevState('verified');
    }
  }
  // ─────────────────────────────────────────────────────────────────────────────

  // Load and initialise the FaceTec SDK
  useEffect(() => {
    const script  = document.createElement('script');
    script.src    = '/facetec/FaceTecSDK.js/FaceTecSDK.js';
    script.async  = true;

    script.onload = () => {
      try {
        const sdk = window.FaceTecSDK;
        sdk.setResourceDirectory('/facetec/FaceTecSDK.js/resources');
        sdk.setImagesDirectory('/facetec/FaceTec_images');
        sdk.initializeInDevelopmentMode(
          DEVICE_KEY_IDENTIFIER,
          PUBLIC_FACE_SCAN_ENCRYPTION_KEY,
          (success: boolean) => { if (success) setSdkReady(true); },
        );
      } catch {
        // sdkReady stays false; button remains disabled
      }
    };

    document.body.appendChild(script);
    return () => { document.body.removeChild(script); };
  }, []);

  function startScan() {
    setScanState('scanning');
    runLivenessScan((result) => setScanState(result));
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-sm border border-gray-200 p-8">

        {/* Wordmark */}
        <div className="mb-7">
          <span className="text-lg font-bold" style={{ color: '#0F4C75' }}>BetterNow</span>
          <h1 className="mt-3 text-2xl font-semibold text-gray-900">Verify your identity</h1>
          <p className="mt-1 text-sm text-gray-500">
            One quick face scan confirms you&apos;re a real person. This keeps BetterNow secure for everyone.
          </p>
        </div>

        {/* Idle / scanning state — show button */}
        {(scanState === 'idle' || scanState === 'scanning') && (
          <button
            onClick={startScan}
            disabled={!sdkReady || scanState === 'scanning'}
            className="w-full rounded-lg px-4 py-3 text-sm font-semibold text-white transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            style={{ backgroundColor: '#0F4C75' }}
          >
            {!sdkReady
              ? 'Preparing secure verification…'
              : scanState === 'scanning'
                ? 'Scanning…'
                : 'Start verification'}
          </button>
        )}

        {/* Proven */}
        {scanState === 'proven' && (
          <div className="text-center space-y-4">
            <p className="text-xl font-semibold text-green-600">
              ✅ Identity verified — you&apos;re all set!
            </p>
            <a
              href="/patient"
              className="inline-flex items-center justify-center w-full rounded-lg px-4 py-3 text-sm font-semibold text-white transition-colors"
              style={{ backgroundColor: '#0F4C75' }}
            >
              Continue
            </a>
          </div>
        )}

        {/* Failed */}
        {scanState === 'failed' && (
          <div className="text-center space-y-4">
            <p className="text-xl font-semibold text-red-600">
              ❌ Verification didn&apos;t pass. Please try again.
            </p>
            <button
              onClick={startScan}
              disabled={!sdkReady}
              className="w-full rounded-lg px-4 py-3 text-sm font-semibold text-white transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              style={{ backgroundColor: '#0F4C75' }}
            >
              Try again
            </button>
          </div>
        )}

        {/* Cancelled */}
        {scanState === 'cancelled' && (
          <div className="text-center space-y-4">
            <p className="text-base text-gray-600">
              Verification cancelled. You&apos;ll need to verify to use BetterNow.
            </p>
            <button
              onClick={startScan}
              disabled={!sdkReady}
              className="w-full rounded-lg px-4 py-3 text-sm font-semibold text-white transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              style={{ backgroundColor: '#0F4C75' }}
            >
              Try again
            </button>
          </div>
        )}

        {/* ── DEV ONLY — remove this entire block before/after production launch ── */}
        {process.env.NODE_ENV !== 'production' && (
          <div className="mt-8 border-2 border-dashed border-amber-400 bg-amber-50 rounded-lg p-4">
            <p className="text-xs font-bold text-amber-700 uppercase tracking-wide mb-3">
              DEV ONLY — not for production
            </p>

            {devState !== 'verified' && (
              <button
                onClick={handleDevBypass}
                disabled={devState === 'loading'}
                className="w-full rounded-lg px-4 py-2 text-sm font-semibold text-amber-900 bg-amber-200 hover:bg-amber-300 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {devState === 'loading' ? 'Verifying…' : 'DEV: simulate successful verification'}
              </button>
            )}

            {devState === 'error' && (
              <p className="mt-2 text-sm text-red-600">{devError}</p>
            )}

            {devState === 'verified' && (
              <div className="text-center space-y-3">
                <p className="text-sm font-semibold text-green-700">
                  ✅ Verified (dev bypass) — you&apos;re all set
                </p>
                <a
                  href="/patient"
                  className="inline-flex items-center justify-center w-full rounded-lg px-4 py-2 text-sm font-semibold text-amber-900 bg-amber-200 hover:bg-amber-300 transition-colors"
                >
                  Continue
                </a>
              </div>
            )}
          </div>
        )}
        {/* ── END DEV ONLY ───────────────────────────────────────────────────────── */}

      </div>
    </div>
  );
}
