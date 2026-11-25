# Side panel (fork)

A session can keep its material open beside the conversation. When the tutor says "let's go back to the first demo" and asks about it, you can work the demo on the right while the question stays open below the conversation, instead of scrolling up to the demo and back down to the question.

Open or close the panel with the button to the right of the phase label at the top (TEACHING, PROBING…), or with **Ctrl+E** (⌘E on macOS). You can change the shortcut in **Settings → Keyboard**. Drag the panel's left edge to resize it. It starts at 480 px and goes from 320 px up to 60% of the session area. The width applies to every session.

## Materials

The **Materials** tab holds what the session produced, in the order it appeared:

- the tutor's interactive demos and figures;
- images: those the tutor shows you and those you attached to your messages;
- the Mermaid diagrams the tutor wrote in its text;
- the plan and the PDF and research readings.

The selector at the top shows the item that's open. Its menu lists every item, and the ‹ › arrows go to the previous and next. Each item appears with its type's icon and its own title when it has one: the demo's title, the figure's title, the image's caption, the PDF's file name or the research question. Untitled items show their type and number, such as "Figure 2" or "Diagram 1". The plan is a shortcut: it opens the plan window, and the panel keeps showing what it showed.

The item fills the rest of the panel and scrolls on its own. Demos run in the panel just like in the conversation, and adapt to its width. A demo in the panel starts from its initial state and is separate from its copy in the conversation. Demos you opened stay alive while the panel is open, so switching to another item and back keeps what you did. Closing the panel or reloading the session starts them over. Figures, images and diagrams still open full screen.

**Show in chat** (the target button next to the arrows) scrolls the conversation to the item and outlines it for a moment. The ↓ button that appears when you scroll up takes you back to the end.

The cards of demos, figures and images the tutor shows, and the diagrams' hover buttons, have an **Open in side panel** button. It opens the panel on that item.

When the panel is open and the tutor delivers a new demo, figure or image, the panel switches to it. The previous demo stays alive in the selector. With the panel closed, nothing changes: the item appears in the conversation as usual.

Each session remembers whether its panel was open and which item it showed.

## Side question

A pinned side question now lives in the same panel, in a **Side question** tab. Side questions still start as before, from a passage or from a question, in their floating window. Pinning one opens the panel on its tab. The tab disappears when the side question is closed or floats again, and the panel goes back to how it was: closed if it only opened for the side question, otherwise on Materials. Closing the whole panel floats a pinned side question again.

## How it works

- **The list.** `components/session-materials.ts` derives the items from the conversation's view messages: demo, figure and reading deliveries (sub-agent steers), shown images (`show_image` results), the learner's image parts, the complete Mermaid fences of the tutor's text parts, and the plan. It is pure; each item has a stable id.
- **The state.** `components/side-panel-state.ts` is the panel's state machine: open or closed, the tab, the selected item, the demos kept alive, and the side question rules above. It also reads and writes what is remembered, in this device's `localStorage` like the sidebar and the graph camera: `lh:side-panel:<session id>` for open/closed and the item, `lh:side-panel-width` for the width.
- **The panel.** `components/side-panel.tsx` holds the `useSidePanel` hook and the panel. It renders the items with the conversation's own components (`DemoOutputCard`, `VisualOutputCard`, `ImageCard`, the brief cards, the markdown renderer for diagrams). Hidden demos stay mounted, invisible and out of the layout, so their iframes keep running.
- **Open in side panel.** `components/side-panel-context.tsx` is the seam between the cards and the panel. The chat page provides it; the panel provides none, so cards inside the panel show no such button, and neither do cards outside a session.
- **Show in chat.** The chat stamps anchors on the cards (`data-material-id`, `data-material-ids` on your messages, `data-text-part-key` on the tutor's text). `revealSessionElement` in `components/session-navigation.tsx` scrolls with the graph links' own scrolling and re-aims for a few frames, because older rows render lazily.

Upstream files touched (small, marked "Fork"):

- `components/chat.tsx`: the toggle, the shortcut, the anchors, and the panel in place of upstream's side-question panel.
- `components/artifacts/demo-card.tsx`, `visual-card.tsx`, `image-card.tsx` and `components/md-blocks.tsx`: the Open in side panel buttons.
- `components/session-navigation.tsx`: `revealSessionElement`.
- `src/core/keyboard.ts` and `components/keyboard-shortcuts.tsx`: the Ctrl+E action.
- `app/globals.css`: the Show in chat outline.

The texts are in the pt-BR catalog (`docs/language.md`). `tests/session-materials.test.ts`, `tests/side-panel-state.test.ts` and `tests/side-panel.test.tsx` cover the list, the state machine, the panel and the shortcut.
