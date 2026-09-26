from __future__ import annotations

from fastapi import HTTPException

from .. import storage
from ..models import Project


def get_project(project_id: str) -> Project:
    try:
        return storage.load(project_id)
    except storage.ProjectNotFound:
        raise HTTPException(404, "Project not found") from None
