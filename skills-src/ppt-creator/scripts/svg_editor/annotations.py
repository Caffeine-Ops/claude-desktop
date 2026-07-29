#!/usr/bin/env python3
"""
PPT Master - SVG Temp-Id Assignment

Single source of truth for the deterministic ``_edit_N`` temp-id algorithm
used to address SVG elements that ship without their own ``id``. Historically
this module also carried the annotation read/write helpers and the
direct-edit (text/attribute/tspan-promotion) helpers used by the old
svg_editor/server.py's browser editor — both were removed when that server
was deleted: annotation state now lives in the desktop renderer's own store
(src/chat/lib/pptPreview/previewStore.ts) and direct element editing was
never carried over to the native editor (see live-preview.md for the current
feature set). ``check_annotations.py`` never imported this module — it scans
``data-edit-target`` / ``data-edit-annotation`` attributes inline — so this
file's only remaining Python consumer is ``slide_preview.py``.

``assign_temp_ids`` is also the canonical reference the TS port
(src/chat/lib/pptPreview/slidePipeline.ts's ``assignTempIds``) must match
byte-for-byte: same clear-then-number-in-document-order algorithm, same
``_edit_N`` naming. Keeping it importable (rather than inlined into
slide_preview.py) is what makes a ``python3 -c`` one-liner usable to generate
an expected id sequence to diff the TS output against.

Usage:
    (library module — imported by slide_preview.py)

Dependencies:
    None (only uses standard library)
"""

import xml.etree.ElementTree as ET

SVG_NS = 'http://www.w3.org/2000/svg'

# Register namespace to avoid ns0: prefix in output
ET.register_namespace('', SVG_NS)


def assign_temp_ids(root: ET.Element) -> None:
    """Assign deterministic temp ids (_edit_0, _edit_1, ...) to elements without one.

    Clears any leftover _edit_N ids from previous sessions first, to avoid
    shifted numbering when elements are added/removed between sessions.
    """
    for elem in root.iter():
        eid = elem.get('id', '')
        if eid.startswith('_edit_'):
            elem.attrib.pop('id', None)

    counter = 0
    for elem in root.iter():
        if elem is root:
            continue
        if elem.get('id') is None:
            elem.set('id', f'_edit_{counter}')
            counter += 1
