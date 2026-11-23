# PocketPDF — phone document scanner & PDF toolkit

A standalone Android app for scanning documents and working with PDFs. Everything runs **on the device**: documents are stored locally and never uploaded.

## Features

**Scanner**
- Live camera preview that outlines the document as you aim. Optional auto-capture fires once the outline holds steady. Flash/torch toggle where the phone supports it.
- Scan from existing photos too, one or many at a time.
- Automatic edge detection suggests a crop frame. You can adjust it with 4 corner handles and 4 edge handles; a magnifier shows detail while you drag. *Auto* re-detects; *Full* uses the whole image.
- Perspective correction straightens skewed, angled shots and recovers the page's true aspect ratio.
- Lighting compensation evens out shadows, gradients and tinted light. Filters: Auto, Color, Grayscale, B&W, Original. Brightness and contrast sliders, plus rotate.
- **Fast multi-page capture:** after adjusting a page's crop, tap **Next page** to go straight back to the camera (it stays on between pages), or **Done**. With photos, it asks whether to add more pages when the batch is finished. No enhancement work happens between pages.
- Straightening and enhancement run for all pages together on the review screen, in the background, with each thumbnail updating as it finishes. One tap there changes the enhancement for all pages. Per page you can re-crop, fine-tune (filter, brightness, contrast), rotate, reorder, retake or delete.
- Save options: page size (fit to scan, Letter, A4, Legal), quality, and optional OCR so the scan becomes searchable and selectable.

**PDF tools**
- **View:** smooth scrolling, pinch/double-tap/button zoom, page indicator, full-text search with highlights.
- **Edit text:** tap any line of existing text to rewrite it (matches size, font family, color and background), or add new text anywhere.
- **Markup:** pen, highlighter, text, box, oval, line, arrow, whiteout, **secure redaction** (flattens the page so hidden text is really removed), eraser, select/move/resize/duplicate, color & size, undo/redo.
- **Fill & Sign:** fill real form fields (text, checkboxes, radio buttons, dropdowns) and save them into the PDF. *Next field* steps through the form. For flat forms, place text, ✓/✗ marks and dates yourself. Draw signatures and initials and save them for reuse. Stamps (Approved, Draft, Paid…) and images.
- **OCR:** recognize text on the current page, all pages, or only pages without text. Adds an invisible text layer and lets you copy or share the text. English is built in; 9 more languages download once when first used.
- **Pages:** reorder, rotate, delete, duplicate, extract to a new document, insert blank pages, insert scans, insert files.
- **Add other file formats:** PDF, images (JPG/PNG/WebP/GIF/BMP/HEIC where supported), Word `.docx`, HTML, TXT/Markdown/CSV/JSON/code files. You can combine many files into one PDF.
- **More:** page numbers, watermark, flatten form, reduce file size, export a page as JPG, share (native share sheet), download, print, rename, document info.
- **Library:** thumbnails, rename, duplicate, delete, multi-select merge.
- Works fully offline. Opens password-protected PDFs. Opens PDFs and images from other apps ("Open with" / "Share"). Dark mode follows the system. The Android back button closes dialogs and goes back a screen.

## Install on your Android phone

PocketPDF is a standalone Android app (`app.pocketpdf.scanner`). It runs without a browser or internet connection, and English OCR is built in.

1. On your phone, open this repository's **Releases** page and tap the latest `PocketPDF-x.y.z.apk`.
2. When Android asks, allow your browser to *install unknown apps*, then tap **Install**.
3. Updates: install the newer APK the same way. It installs over the old version and keeps your documents.

Once installed, PocketPDF appears under **Open with** and **Share** for PDFs, images, Word files and text files in other apps (Files, Gmail, Drive, WhatsApp…). **Save to Documents folder** writes to `Documents/PocketPDF/`. Share and print go through Android's share sheet.

### How the APK is built
`.github/workflows/android.yml` runs on every push. It builds the web app, wraps it with [Capacitor](https://capacitorjs.com/) (`android/`), compiles a signed release APK, and publishes it as a GitHub Release. Pushes to `main` become the "Latest" release; other branches become pre-releases. The APK is also attached to each workflow run as an artifact.

**Signing:** by default the APK is signed with `android/app/pocketpdf-public.keystore` (password `pocketpdf`). That key is committed so every build installs over the previous one. Because this repository is public, anyone could sign an APK with it. For a private key, generate one with
`keytool -genkeypair -keystore release.keystore -alias pocketpdf -keyalg RSA -keysize 2048 -validity 10000`
and add the repository secrets `ANDROID_KEYSTORE_BASE64` (the output of `base64 -w0 release.keystore`), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`. Switching keys needs a one-time uninstall and reinstall, so export your documents first.

### Build locally
Requires Node 22, JDK 21 and the Android SDK (or Android Studio):
```bash
npm install
npm run build && npx cap sync android
cd android && ./gradlew assembleRelease    # APK in android/app/build/outputs/apk/release/
# or: npx cap open android                  # open in Android Studio and press Run
```

## Develop the web layer
```bash
npm run dev      # http://localhost:5173 in a browser; the same code runs inside the Android app
```
The app also still works as an installable web app (PWA); `.github/workflows/deploy.yml` publishes it to GitHub Pages from `main` if Pages is enabled.

Tech: TypeScript + Vite (no UI framework), Capacitor 8 for the Android shell, [pdf.js](https://mozilla.github.io/pdf.js/) for rendering, [pdf-lib](https://pdf-lib.js.org/) for writing, [Tesseract.js](https://tesseract.projectnaptha.com/) for OCR, [mammoth](https://github.com/mwilson/mammoth.js) for `.docx`. Document detection, perspective correction and lighting correction are plain JS in `src/scanner/`. Native code (receiving shared/opened files) is in `android/app/src/main/java/app/pocketpdf/scanner/`.

## Limitations
- Text editing replaces a line by covering it and redrawing it with a standard font (Helvetica/Times/Courier). It matches size and color, but not custom embedded fonts. Only standard Latin (WinAnsi) characters are supported in new text.
- XFA (LiveCycle) forms can't be filled field-by-field. Use the Text/Check tools on them instead.
- Encrypted PDFs open for viewing; saving changes to them may fail.
- Adding password protection to PDFs is not supported.
