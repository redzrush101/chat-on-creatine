import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Project } from '@shared/types';
import { readJsonSync, writeJson } from '../core/durable';
import { Emitter } from '../core/emitter';

/** Persisted catalog of local project folders. Paths are stored canonical (real, absolute). */
export class ProjectStore {
  private projects: Project[];
  private readonly emitter = new Emitter<{ change: Project[] }>();
  /** Mutations run one at a time so each one builds on the catalog the previous one wrote. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {
    this.projects = readJsonSync<Project[]>(file, []);
  }

  list(): Project[] {
    return [...this.projects];
  }

  get(id: string): Project | null {
    return this.projects.find((project) => project.id === id) ?? null;
  }

  /** Adding a folder that is already known returns the existing project. */
  add(folder: string, name?: string): Promise<Project> {
    return this.mutate(async () => {
      if (!path.isAbsolute(folder)) throw new Error('Choose an absolute project folder');
      const real = await realpath(folder);
      if (!(await stat(real)).isDirectory()) throw new Error('Choose a project folder');

      const existing = this.projects.find((project) => project.path === real);
      if (existing) return existing;

      const project: Project = {
        id: randomUUID(),
        name: name?.trim() || path.basename(real) || real,
        path: real,
        createdAt: Date.now()
      };
      await this.commit([...this.projects, project]);
      return project;
    });
  }

  update(id: string, patch: Partial<Pick<Project, 'name'>>): Promise<Project> {
    return this.mutate(async () => {
      const current = this.require(id);
      const name = patch.name?.trim() ?? current.name;
      if (!name) throw new Error('Project name cannot be empty');
      const next: Project = { ...current, name };
      await this.commit(this.projects.map((project) => (project.id === id ? next : project)));
      return next;
    });
  }

  remove(id: string): Promise<void> {
    return this.mutate(async () => {
      this.require(id);
      await this.commit(this.projects.filter((project) => project.id !== id));
    });
  }

  onChange(listener: (projects: Project[]) => void): () => void {
    return this.emitter.on('change', listener);
  }

  private require(id: string): Project {
    const project = this.get(id);
    if (!project) throw new Error('Project not found');
    return project;
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation);
    this.queue = run.catch(() => {});
    return run;
  }

  private async commit(next: Project[]): Promise<void> {
    await writeJson(this.file, next);
    this.projects = next;
    this.emitter.emit('change', this.list());
  }
}
