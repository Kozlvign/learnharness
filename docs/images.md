# Images in messages (fork)

You can send the tutor images with your messages: a screenshot of an exercise, a photo of your handwritten work, a diagram from a book.

- **Paste** with Ctrl+V in the message box. A paste anywhere outside a text field works too.
- **Drop** image files anywhere on the page. Other files you drop become upstream's file path chips, and when you drop both kinds at once, each goes its own way. While a question or a practice problem is open, or the session is being summarized, the message box can't take images, so dropped images become path chips too (desktop app only); the tutor can open them with its file reader.
- **Pick** files with the image button left of the message box.

Up to 8 images per message, with or without text. Thumbnails show above the text while they attach; hover one to remove it, click it to see it full size. Sent images appear in your message in the conversation, and clicking one opens it full size (Esc closes it).

It works in a running session, while the tutor is still answering (the image rides with your steering message), on **New session** and on the home screen, so a session can start from a screenshot alone. Such a session is named "Image" until you rename it.

The images go to the tutor's model as images. Every Claude model sees them, including through the Claude connection. When the model in use cannot see images, it gets a short note instead and tells you so, so pick a model that can, or describe the image in words.

## Size and cost

Before uploading, each image is scaled down to at most 1568 pixels on its longest side and about 1.15 megapixels. Claude reduces larger images to about that size anyway, so the scaling only saves upload time and tokens: an image at that size costs about 1,500 tokens. Small PNG, JPEG and WebP images are sent unchanged. Larger screenshots stay PNG while that keeps them small, and photos become JPEG.

The tutor sees the whole conversation on every reply, images included, until a long session is summarized. The summary mentions that you attached images, but not what was in them.

## How it works

- **The message.** A message with images keeps the native shape every provider reads: image blocks followed by the text (`src/core/attachments.ts`). The chat record keeps each image as a file name with empty data, so chat files stay small. The sidebar reads every chat file on each refresh, which is why the image bytes stay out of them.
- **The files.** `POST /api/attachments` checks that the bytes really are PNG, JPEG, WebP or GIF and at most 3.75 MB, about 5 MB once encoded, which is the strictest provider limit. It stores them in `<data>/attachments` under a name made from their SHA-256, so the same image attached twice is stored once. `GET /api/attachments/<name>` serves them to the conversation (`src/server/attachments-http.ts`). Both routes follow the same-origin rules of the other fork controls, behind the desktop proxy.
- **Model calls.** `src/agent/models.ts` passes every model call through `withAttachedImages` (`src/agent/attachments.ts`). It reads the files back into the request, keeps recently used ones in memory, and never changes the record.
- **Cleanup.** Images that no chat refers to are deleted after 7 days. That leaves time for drafts that were not sent yet, and also covers images of deleted sessions. The check runs at most twice a day, when an image is uploaded.
- **Dropping.** Upstream's drop zone (`components/file-path-drop-zone.tsx`) covers the content area and turns dropped files into path chips. While a composer can attach images, it registers in `components/attachments/drop-target.ts`, and the zone hands it the dropped images before making chips of the rest. A drag of images only shows the tray's hint instead of the zone's overlay. Drops on the sidebar, outside the zone, go to the composer directly.
- **New sessions.** Upstream hands a new session's opening message to the chat page through `sessionStorage` (`components/opening-prompt.ts`). The entry also carries the images, so the text may be empty. `SessionStarter` (`components/start-session.ts`) takes the opening apart from the title, which is "Image" for a start from images alone. If the opening can't be sent, its images go back to the tray along with its text.
- **The composer.** `components/attachments/` holds the paste, drop and picker handling, the scaling (`image-files.ts`), the tray, the attach button, the images in sent messages and the full-size viewer. A paste that also carries plain text, such as a copy from an office document, stays a text paste.

Upstream files touched (small, marked "Fork"):

- `src/core/input-events.ts`: sends and steers accept `images`.
- `src/core/native-messages.ts`: user messages and steers build the image blocks.
- `src/core/view.ts`: user messages show their images.
- `src/core/compaction.ts`: the summarizer input names attached images.
- `src/agent/models.ts`: the model calls.
- `components/session-core.ts` and `components/session.ts`: sends and steers with images.
- `components/composer.tsx`, `components/chat.tsx`, `components/new-session.tsx` and `components/home.tsx`: the tray, the button and the sends.
- `components/opening-prompt.ts` and `components/start-session.ts`: a new session's opening images.
- `components/file-path-drop-zone.tsx`: dropped images go to the composer.
- `app/api/chats/[id]/steer/route.ts`: steers with images.

`tests/images.test.tsx` covers the input events, the record and view, the model calls, the routes, the cleanup and the composer.
