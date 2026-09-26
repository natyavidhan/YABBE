"""Tiny in-process background job system with progress reporting."""

from __future__ import annotations

import logging
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Literal, Optional

from pydantic import BaseModel, Field

from . import config
from .models import new_id

log = logging.getLogger("yabbe.jobs")

JobStatus = Literal["queued", "running", "done", "error", "cancelled"]


class Job(BaseModel):
    id: str = Field(default_factory=lambda: new_id("j_"))
    kind: str
    project_id: Optional[str] = None
    label: str = ""
    status: JobStatus = "queued"
    progress: float = 0.0  # 0..1
    message: str = ""
    error: Optional[str] = None
    result: Optional[dict[str, Any]] = None
    created_at: float = Field(default_factory=time.time)
    finished_at: Optional[float] = None


class JobCancelled(Exception):
    pass


class JobContext:
    """Handed to job functions so they can report progress / check cancellation."""

    def __init__(self, job: Job, cancel: threading.Event):
        self.job = job
        self._cancel = cancel

    def progress(self, value: float, message: Optional[str] = None) -> None:
        self.job.progress = max(0.0, min(1.0, value))
        if message is not None:
            self.job.message = message
        if self._cancel.is_set():
            raise JobCancelled()

    @property
    def cancelled(self) -> bool:
        return self._cancel.is_set()


class JobManager:
    def __init__(self, workers: int):
        self._pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="yabbe-job")
        self._jobs: dict[str, Job] = {}
        self._cancel: dict[str, threading.Event] = {}
        self._lock = threading.Lock()

    def submit(
        self,
        kind: str,
        fn: Callable[[JobContext], Optional[dict[str, Any]]],
        project_id: Optional[str] = None,
        label: str = "",
    ) -> Job:
        job = Job(kind=kind, project_id=project_id, label=label)
        cancel = threading.Event()
        with self._lock:
            self._jobs[job.id] = job
            self._cancel[job.id] = cancel
            self._prune()
        self._pool.submit(self._run, job, cancel, fn)
        return job

    def _run(self, job: Job, cancel: threading.Event, fn) -> None:
        if cancel.is_set():
            job.status = "cancelled"
            job.finished_at = time.time()
            return
        job.status = "running"
        ctx = JobContext(job, cancel)
        try:
            job.result = fn(ctx)
            job.progress = 1.0
            job.status = "done"
        except JobCancelled:
            job.status = "cancelled"
        except Exception as exc:  # noqa: BLE001 - report every failure to the UI
            if cancel.is_set():
                job.status = "cancelled"
            else:
                log.error("job %s (%s) failed: %s", job.id, job.kind, traceback.format_exc())
                job.status = "error"
                job.error = str(exc) or exc.__class__.__name__
        finally:
            job.finished_at = time.time()

    def get(self, job_id: str) -> Optional[Job]:
        return self._jobs.get(job_id)

    def list(self, project_id: Optional[str] = None) -> list[Job]:
        jobs = list(self._jobs.values())
        if project_id:
            jobs = [j for j in jobs if j.project_id == project_id]
        return sorted(jobs, key=lambda j: j.created_at, reverse=True)

    def cancel(self, job_id: str) -> bool:
        ev = self._cancel.get(job_id)
        if ev is None:
            return False
        ev.set()
        return True

    def cancel_project(self, project_id: str) -> None:
        for job in self.list(project_id):
            if job.status in ("queued", "running"):
                self.cancel(job.id)

    def _prune(self, keep_seconds: float = 3600) -> None:
        now = time.time()
        for jid, job in list(self._jobs.items()):
            if job.finished_at and now - job.finished_at > keep_seconds:
                self._jobs.pop(jid, None)
                self._cancel.pop(jid, None)

    def shutdown(self) -> None:
        for ev in self._cancel.values():
            ev.set()
        self._pool.shutdown(wait=False, cancel_futures=True)


jobs = JobManager(config.JOB_WORKERS)
