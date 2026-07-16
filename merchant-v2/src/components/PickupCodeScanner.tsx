import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, CameraOff, ScanLine } from 'lucide-react';

type ScannerState =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'scanning'; hint?: string }
  | { phase: 'success'; message: string }
  | { phase: 'error'; message: string };

interface DetectedBarcode {
  rawValue?: string;
}

interface BarcodeDetectorInstance {
  detect(source: CanvasImageSource): Promise<readonly DetectedBarcode[]>;
}

type BarcodeDetectorConstructor = new () => BarcodeDetectorInstance;

export function PickupCodeScanner({
  disabled,
  onCode,
}: {
  disabled: boolean;
  onCode(code: string): void;
}) {
  const [state, setState] = useState<ScannerState>({ phase: 'idle' });
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const timerRef = useRef<number | undefined>(undefined);
  const generationRef = useRef(0);

  const releaseStream = useCallback(() => {
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
    timerRef.current = undefined;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = undefined;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const cancelScan = useCallback(() => {
    generationRef.current += 1;
    releaseStream();
  }, [releaseStream]);

  useEffect(() => cancelScan, [cancelScan]);

  useEffect(() => {
    if (!disabled) return;
    cancelScan();
    setState({ phase: 'idle' });
  }, [cancelScan, disabled]);

  async function startScan() {
    if (disabled) return;
    cancelScan();
    const generation = generationRef.current;
    setState({ phase: 'starting' });

    const Detector = barcodeDetectorConstructor();
    if (!Detector) {
      setState({ phase: 'error', message: '当前浏览器不支持二维码识别，请手工输入六位核销码。' });
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setState({ phase: 'error', message: '当前浏览器无法访问相机，请手工输入六位核销码。' });
      return;
    }

    let detector: BarcodeDetectorInstance;
    try {
      detector = new Detector();
    } catch {
      setState({ phase: 'error', message: '扫码识别器初始化失败，请手工输入六位核销码。' });
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' } },
      });
      if (generationRef.current !== generation) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) throw new Error('Camera preview is unavailable');
      video.srcObject = stream;
      await video.play();
      if (generationRef.current !== generation) return;
      setState({ phase: 'scanning' });

      const detect = async () => {
        if (generationRef.current !== generation || !videoRef.current) return;
        try {
          const barcodes = await detector.detect(videoRef.current);
          if (generationRef.current !== generation) return;
          const code = barcodes
            .map((barcode) => barcode.rawValue?.trim() ?? '')
            .find((value) => /^[0-9]{6}$/.test(value));
          if (code) {
            generationRef.current += 1;
            releaseStream();
            onCode(code);
            setState({ phase: 'success', message: '已识别六位核销码，请核对后确认核销。' });
            return;
          }
          setState({
            phase: 'scanning',
            ...(barcodes.length > 0 ? { hint: '识别内容不是六位核销码，正在继续扫描。' } : {}),
          });
          timerRef.current = window.setTimeout(() => void detect(), 250);
        } catch {
          generationRef.current += 1;
          releaseStream();
          setState({ phase: 'error', message: '相机画面识别失败，请重新扫码或手工输入六位核销码。' });
        }
      };
      void detect();
    } catch (error) {
      if (generationRef.current !== generation) return;
      generationRef.current += 1;
      releaseStream();
      setState({ phase: 'error', message: cameraErrorMessage(error) });
    }
  }

  function stopScan() {
    cancelScan();
    setState({ phase: 'idle' });
  }

  const cameraActive = state.phase === 'starting' || state.phase === 'scanning';
  return (
    <div className="pickup-scanner">
      <div className="pickup-scanner-toolbar">
        <div>
          <strong>相机扫码</strong>
          <span>只识别完整六位码，识别后仍需人工确认。</span>
        </div>
        {cameraActive ? (
          <button className="button secondary" onClick={stopScan} type="button">
            <CameraOff aria-hidden="true" size={16} /> 停止扫码
          </button>
        ) : (
          <button className="button secondary" disabled={disabled} onClick={() => void startScan()} type="button">
            <Camera aria-hidden="true" size={16} /> 启动相机扫码
          </button>
        )}
      </div>
      <video
        aria-label="核销码相机预览"
        className="pickup-camera-preview"
        hidden={!cameraActive}
        muted
        playsInline
        ref={videoRef}
      />
      {state.phase === 'starting' ? <p className="scanner-status" role="status">正在请求相机权限…</p> : null}
      {state.phase === 'scanning' ? (
        <p className="scanner-status" role="status">
          <ScanLine aria-hidden="true" size={15} /> {state.hint ?? '请将核销码置于取景框中央。'}
        </p>
      ) : null}
      {state.phase === 'success' ? <p className="form-success" role="status">{state.message}</p> : null}
      {state.phase === 'error' ? <p className="form-error" role="alert">{state.message}</p> : null}
    </div>
  );
}

function barcodeDetectorConstructor() {
  return (globalThis as typeof globalThis & { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector;
}

function cameraErrorMessage(error: unknown) {
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return '相机权限被拒绝，请在浏览器授权后重试，或手工输入六位核销码。';
  }
  if (error instanceof DOMException && error.name === 'NotFoundError') {
    return '未找到可用相机，请手工输入六位核销码。';
  }
  return '相机启动失败，请检查设备后重试，或手工输入六位核销码。';
}
