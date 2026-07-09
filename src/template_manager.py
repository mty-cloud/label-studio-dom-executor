from __future__ import annotations

import json
from pathlib import Path
from typing import List


class TemplateManager:
    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.templates: List[str] = []
        self.load()

    def load(self) -> List[str]:
        if not self.path.exists():
            self.templates = []
            self.save()
            return self.templates
        data = json.loads(self.path.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            items = data.get("templates", [])
        elif isinstance(data, list):
            items = data
        else:
            items = []
        self.templates = [str(x) for x in items if str(x).strip()]
        return self.templates

    def save(self) -> None:
        self.path.write_text(json.dumps({"templates": self.templates}, ensure_ascii=False, indent=2), encoding="utf-8")

    def add(self, text: str) -> None:
        text = text.strip()
        if text and text not in self.templates:
            self.templates.append(text)
            self.save()

    def update(self, index: int, text: str) -> None:
        text = text.strip()
        if not text:
            return
        if 0 <= index < len(self.templates):
            self.templates[index] = text
            self.save()

    def delete(self, index: int) -> None:
        if 0 <= index < len(self.templates):
            self.templates.pop(index)
            self.save()

    def move_up(self, index: int) -> int:
        if 1 <= index < len(self.templates):
            self.templates[index - 1], self.templates[index] = self.templates[index], self.templates[index - 1]
            self.save()
            return index - 1
        return index

    def move_down(self, index: int) -> int:
        if 0 <= index < len(self.templates) - 1:
            self.templates[index + 1], self.templates[index] = self.templates[index], self.templates[index + 1]
            self.save()
            return index + 1
        return index
