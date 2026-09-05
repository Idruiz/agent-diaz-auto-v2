# PowerPoint notesMasterIdLst ordering incident

Incident date: 2026-09-02.

Broken artifact SHA256:
`f9cc83765aefb7f1bb12e109f6bbda5595d28334df9587fc4ea15ce4f9539d92`.

`V0.presentation.xml` is the exact `ppt/presentation.xml` extracted from the user-reported PowerPoint-rejected artifact. It records the proven-bad placement of `notesMasterIdLst` before `sldIdLst`.

`V7.order-sentinel.xml` records the PowerPoint-tested native PptxGenJS ordering: `notesMasterIdLst` after `sldIdLst`.

The complete V0 PPTX bytes are available from the incident specimen. The exact complete V7 PPTX bytes were not supplied to this coding session, so this repository does not fabricate a binary V7 fixture. Add that exact user-tested file when supplied.
