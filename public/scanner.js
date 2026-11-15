'use strict';

/**
 * Skanowanie etykiet w przeglądarce:
 *  - kod kreskowy: na żywo z kamery (BarcodeDetector lub ZXing), ze zdjęcia albo wpisany ręcznie,
 *  - data ważności: OCR zdjęcia etykiety (Tesseract.js) + parser dat po stronie serwera.
 *
 * Kamera na żywo wymaga bezpiecznego kontekstu (HTTPS lub localhost). Przez zwykłe HTTP
 * w sieci domowej działa wariant „Zrób zdjęcie”, który otwiera aparat telefonu.
 */
const Scanner = (() => {
  const TESSERACT_VERSION = '5.1.1';
  const CDN = 'https://cdn.jsdelivr.net/npm';
  const TESSERACT = {
    script: `${CDN}/tesseract.js@${TESSERACT_VERSION}/dist/tesseract.min.js`,
    workerPath: `${CDN}/tesseract.js@${TESSERACT_VERSION}/dist/worker.min.js`,
    corePath: `${CDN}/tesseract.js-core@${TESSERACT_VERSION}`,
    langPath: `${CDN}/@tesseract.js-data/eng@1.0.0/4.0.0_best_int`,
  };
  const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'];

  const $ = (sel) => document.querySelector(sel);
  const scripts = new Map();

  function loadScript(src) {
    if (!scripts.has(src)) {
      scripts.set(src, new Promise((resolve, reject) => {
        const el = document.createElement('script');
        el.src = src;
        el.onload = resolve;
        el.onerror = () => {
          scripts.delete(src);
          reject(new Error(`Nie udało się wczytać biblioteki (${new URL(src, location.href).host})`));
        };
        document.head.append(el);
      }));
    }
    return scripts.get(src);
  }

  let zxingPromise;
  function zxingReader() {
    zxingPromise ??= loadScript('vendor/zxing.min.js').then(() => {
      const hints = new Map();
      hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
      return new ZXing.BrowserMultiFormatReader(hints);
    }).catch((err) => {
      zxingPromise = null;
      throw err;
    });
    return zxingPromise;
  }

  let detectorPromise;
  function nativeDetector() {
    detectorPromise ??= (async () => {
      if (!('BarcodeDetector' in window)) return null;
      try {
        const supported = await BarcodeDetector.getSupportedFormats();
        const formats = FORMATS.filter((f) => supported.includes(f));
        return formats.length ? new BarcodeDetector({ formats }) : null;
      } catch {
        return null;
      }
    })();
    return detectorPromise;
  }

  const canUseLiveCamera = () => window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;

  /** Zmniejsza zdjęcie (telefony robią 12+ Mpx) – szybsze i pewniejsze dekodowanie. */
  async function fileToCanvas(file, maxSide) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /** Szuka kodu na obrazie z płótna: najpierw natywny BarcodeDetector, potem ZXing. */
  async function decodeCanvas(canvas) {
    const detector = await nativeDetector();
    if (detector) {
      try {
        const found = await detector.detect(canvas);
        if (found.length) return found[0].rawValue;
      } catch { /* spróbuj ZXing */ }
    }
    const reader = await zxingReader();
    try {
      const source = new ZXing.HTMLCanvasElementLuminanceSource(canvas);
      return reader.decodeBitmap(new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(source))).getText();
    } catch {
      return null; // NotFoundException – brak kodu w tej klatce
    }
  }

  async function decodeImage(file) {
    return decodeCanvas(await fileToCanvas(file, 1600));
  }

  // ---------- Kod kreskowy ----------

  /** Otwiera okno skanowania. Zwraca odczytany kod albo null (anulowano). */
  function scanBarcode() {
    const dialog = $('#scan-dialog');
    const video = $('#scan-video');
    const live = $('#scan-live');
    const hint = $('#scan-hint');
    const error = $('#scan-error');
    const photo = $('#scan-photo');
    const manual = $('#scan-manual');

    return new Promise((resolve) => {
      let done = false;
      let stream = null;
      let timer = null;

      const cleanup = () => {
        clearTimeout(timer);
        stream?.getTracks().forEach((t) => t.stop());
        video.srcObject = null;
        photo.onchange = null;
        manual.onsubmit = null;
        dialog.removeEventListener('close', onClose);
      };
      const finish = (code) => {
        if (done) return;
        done = true;
        cleanup();
        if (dialog.open) dialog.close();
        if (code) navigator.vibrate?.(60);
        resolve(code ? String(code).trim() : null);
      };
      const onClose = () => finish(null);
      const showError = (msg) => {
        error.textContent = msg;
        error.hidden = !msg;
      };

      showError('');
      manual.reset();
      dialog.addEventListener('close', onClose);
      dialog.showModal();

      manual.onsubmit = (e) => {
        e.preventDefault();
        const code = manual.elements.code.value.trim();
        if (code) finish(code);
      };

      photo.onchange = async () => {
        const file = photo.files[0];
        photo.value = '';
        if (!file) return;
        showError('');
        hint.textContent = 'Odczytywanie kodu ze zdjęcia…';
        try {
          const code = await decodeImage(file);
          if (code) return finish(code);
          showError('Nie znaleziono kodu na zdjęciu. Spróbuj z bliska, przy dobrym świetle.');
        } catch (err) {
          showError(err.message);
        }
        hint.textContent = '';
      };

      if (!canUseLiveCamera()) {
        live.hidden = true;
        hint.textContent = 'Zrób zdjęcie kodu kreskowego albo wpisz go ręcznie.';
        return;
      }

      live.hidden = false;
      hint.textContent = 'Skieruj aparat na kod kreskowy…';
      (async () => {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false,
          });
          if (done) return cleanup();
          video.srcObject = stream;
          await video.play();
          await zxingReader(); // wczytaj zawczasu, by pierwsza klatka nie czekała
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          const tick = async () => {
            if (done) return;
            if (video.videoWidth) {
              canvas.width = video.videoWidth;
              canvas.height = video.videoHeight;
              ctx.drawImage(video, 0, 0);
              const code = await decodeCanvas(canvas);
              if (code) return finish(code);
            }
            timer = setTimeout(tick, 200);
          };
          tick();
        } catch (err) {
          live.hidden = true;
          hint.textContent = 'Zrób zdjęcie kodu kreskowego albo wpisz go ręcznie.';
          showError(err?.name === 'NotAllowedError' ? 'Brak dostępu do aparatu.' : `Aparat niedostępny: ${err.message ?? err}`);
        }
      })();
    });
  }

  // ---------- Data ważności (OCR) ----------

  let workerPromise;
  let ocrProgress = null;
  async function ocrWorker(onProgress) {
    ocrProgress = onProgress;
    workerPromise ??= (async () => {
      await loadScript(TESSERACT.script);
      return Tesseract.createWorker('eng', 1, {
        workerPath: TESSERACT.workerPath,
        corePath: TESSERACT.corePath,
        langPath: TESSERACT.langPath,
        logger: (m) => ocrProgress?.(m),
      });
    })().catch((err) => {
      workerPromise = null;
      throw err;
    });
    return workerPromise;
  }

  /**
   * Otwiera okno odczytu daty. `parse(text)` zwraca { date } (parser na serwerze).
   * Wynik: data RRRR-MM-DD albo null.
   */
  function scanExpiry(parse) {
    const dialog = $('#ocr-dialog');
    const photo = $('#ocr-photo');
    const preview = $('#ocr-preview');
    const status = $('#ocr-status');
    const result = $('#ocr-result');
    const dateInput = $('#ocr-date');
    const textOut = $('#ocr-text');
    const useBtn = $('#ocr-use');

    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        photo.onchange = null;
        useBtn.onclick = null;
        dialog.removeEventListener('close', onClose);
        if (preview.src) URL.revokeObjectURL(preview.src);
        preview.removeAttribute('src');
        if (dialog.open) dialog.close();
        resolve(value);
      };
      const onClose = () => finish(null);

      preview.hidden = true;
      result.hidden = true;
      useBtn.disabled = true;
      status.textContent = '';
      dateInput.value = '';
      dialog.addEventListener('close', onClose);
      dialog.showModal();

      dateInput.oninput = () => { useBtn.disabled = !dateInput.value; };
      useBtn.onclick = () => finish(dateInput.value || null);

      photo.onchange = async () => {
        const file = photo.files[0];
        photo.value = '';
        if (!file) return;
        if (preview.src) URL.revokeObjectURL(preview.src);
        preview.src = URL.createObjectURL(file);
        preview.hidden = false;
        result.hidden = true;
        useBtn.disabled = true;
        status.textContent = 'Przygotowanie rozpoznawania tekstu…';
        try {
          const worker = await ocrWorker((m) => {
            if (m.status === 'recognizing text') status.textContent = `Rozpoznawanie tekstu… ${Math.round(m.progress * 100)}%`;
            else if (m.status?.startsWith('loading')) status.textContent = 'Pobieranie modelu OCR (tylko za pierwszym razem)…';
          });
          const canvas = await fileToCanvas(file, 2000);
          const { data } = await worker.recognize(canvas);
          const text = (data.text || '').trim();
          textOut.textContent = text || '(nie rozpoznano tekstu)';
          const { date } = await parse(text);
          result.hidden = false;
          dateInput.value = date ?? '';
          useBtn.disabled = !date;
          status.textContent = date
            ? 'Sprawdź odczytaną datę i zatwierdź.'
            : 'Nie znaleziono daty – zrób zdjęcie bliżej daty albo wpisz ją ręcznie.';
        } catch (err) {
          status.textContent = `Błąd OCR: ${err.message ?? err}`;
          result.hidden = false;
        }
      };
    });
  }

  return { scanBarcode, scanExpiry, canUseLiveCamera };
})();
