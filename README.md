# Vectorizer

Trace black & white images into clean SVG paths — logos, line art, stencils.
Runs entirely in the browser: no upload, no install, no build step. Built on
[SACRVM APPKIT](https://github.com/SACRVM/sacrvm-appkit); runs standalone or
as an app on a SACRVM desktop.

```bash
npx serve .
```

## What it does

A true raster-to-vector tracer, the same kind of algorithm as Inkscape's
"Trace Bitmap". The source and the traced vector sit side by side and zoom and
pan together; the right pane is exactly what gets saved.

- **Threshold:** automatic (Otsu) or by hand; invert to trace white shapes.
- **Alpha as mask:** a transparent cut-out becomes one silhouette, whatever
  its colours — it switches on by itself when the image has transparency.
- **Trace quality:** despeckle stray blobs, smooth or keep corners crisp,
  right-angle enhance for letterforms and boxy logos.
- **Output:** any fill colour, optional background fill, anchor-point
  overlay, and a checker / white / dark preview backdrop.
- **In:** open, drop or paste (Ctrl+V) a PNG, JPG, WebP or BMP.
  **Out:** save the SVG or copy its markup.

## Install on a desktop

Paste `github.com/SACRVM/vectorizer` into a SACRVM desktop's install dialog,
or pick it from the App Store tab there.

## Credits

Tracing engine: [ImageTracer.js](https://github.com/jankovicsandras/imagetracerjs)
1.2.6 by András Jankovics, public domain (The Unlicense), vendored unchanged
in `vendor/`.

## License

MIT — see `LICENSE`.
