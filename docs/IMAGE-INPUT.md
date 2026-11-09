# Image input

The non-interactive `nellx run` command accepts up to four workspace-relative image files:

```sh
nellx run "Describe this screenshot" --workspace . --image screenshots/ui.png
```

Supported raster formats are PNG, JPEG, WebP, and GIF. Each image must be non-empty and no larger than 4 MB; the provider adapter caps total decoded image bytes per request at 8 MB. The CLI checks file signatures and workspace boundaries before reading an image. Image bytes are sent inline to the configured Gemini provider and are not stored in session history or settings. The session records the workspace-relative image path; attach the image again when continuing a later request that needs its visual content. Model availability depends on Gemini's image-input support for the selected model; API/model rejections are surfaced normally.
