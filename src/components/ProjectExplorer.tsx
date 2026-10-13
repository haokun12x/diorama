import { useState } from "react";
import { projects } from "../data/projects";
import { kernel } from "../app/machine";
export default function ProjectExplorer() {
  const [id, setId] = useState(projects[0].id);
  const p = projects.find((p) => p.id === id)!;
  return (
    <div className="project-explorer">
      <aside>
        <p className="micro">/HOME/VISITOR/PROJECTS</p>
        {projects.map((p) => (
          <button
            key={p.id}
            className={p.id === id ? "selected" : ""}
            onClick={() => setId(p.id)}
          >
            <span>▱</span> {p.id}
            <small>README.md</small>
          </button>
        ))}
      </aside>
      <article>
        <p className="micro">{p.category}</p>
        <h3>{p.title}</h3>
        <p className="project-summary">{p.summary}</p>
        <div className="project-facts">
          {[
            ["Problem", p.problem],
            ["Core idea", p.idea],
            ["Implementation", p.details],
            ["Engineering challenge", p.challenge],
            ["Evidence", p.evidence],
          ].map(([name, text]) => (
            <div key={name}>
              <h4>{name}</h4>
              <p>{text}</p>
            </div>
          ))}
        </div>
        <div className="project-links">
          <a
            className="primary small"
            href={p.url}
            target="_blank"
            rel="noreferrer"
          >
            Explore project ↗
          </a>
          <a
            className="text-button"
            href={p.repo}
            target="_blank"
            rel="noreferrer"
          >
            Read the source ↗
          </a>
        </div>
        <details>
          <summary>Virtual filesystem / shared source</summary>
          <pre className="project-readme">
            {kernel.fs.exists("/home/visitor/projects/" + p.id + "/README.md")
              ? new TextDecoder().decode(
                  (
                    kernel.fs.entries.get(
                      "/home/visitor/projects/" + p.id + "/README.md",
                    ) as { data: Uint8Array }
                  ).data,
                )
              : "This project file was removed from your workspace. Reset the workspace to restore it."}
          </pre>
        </details>
      </article>
    </div>
  );
}
