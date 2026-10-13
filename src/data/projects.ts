export type Project = {
  id: string;
  title: string;
  category: string;
  summary: string;
  problem: string;
  idea: string;
  details: string;
  challenge: string;
  evidence: string;
  url: string;
  repo: string;
};
export const projects: Project[] = [
  {
    id: "wavefill",
    title: "WaveFill",
    category: "GPU KERNELS / C++ · CUDA",
    summary: "Making long-context prefill fit the machine.",
    problem:
      "Long prompts spend much of their prefill time in causal attention on a single RTX 5090.",
    idea: "Split each attention tile across a thread-block cluster, then merge through distributed shared memory.",
    details:
      "A focused fork of NInfer. Changes include cluster split-KV, scaled FP16 P·V accumulation, and a smaller NVFP4 down-projection GEMV instruction footprint. Upstream NInfer provides the inference engine.",
    challenge:
      "Preserve numerical behavior while tuning cluster occupancy and working within a 600 W power limit.",
    evidence:
      "The project reports 128k prefill falling from 33.8 s to 28.6 s for its documented Qwen3.8-27B NVFP4 configuration. These are source-reported results, not measurements made by DIORAMA.",
    url: "https://haokun12x.github.io/wavefill/",
    repo: "https://github.com/haokun12x/wavefill",
  },
  {
    id: "post-training",
    title: "Post-Training Systems",
    category: "LLM SYSTEMS / RESEARCH NOTES",
    summary: "From the objective to the systems underneath.",
    problem:
      "Post-training stacks combine trainers, rollouts, serving, and resource management with different responsibilities.",
    idea: "Start with a shared gradient equation, then map its terms to six layers of the tool stack.",
    details:
      "An interactive knowledge map, memory calculators, bilingual films, and source-code engineering reports covering framework tradeoffs and reinforcement-learning loops.",
    challenge:
      "Separate trainer concerns from the systems problem created when the sampling distribution depends on the changing policy.",
    evidence:
      "Public notes and source-linked engineering comparisons. The source explicitly says no unified GPU benchmark was run.",
    url: "https://haokun12x.github.io/post-training-101/",
    repo: "https://github.com/haokun12x/post-training-101",
  },
  {
    id: "agentic-systems",
    title: "Systems Fieldnotes",
    category: "AGENT ARCHITECTURE / RUNTIME CONTRACTS",
    summary: "An agent is a loop. A useful agent is a system.",
    problem:
      "Agent behavior depends on context, tools, observations, persistence, and control boundaries.",
    idea: "Follow a request through the application, then compare LangGraph and custom Rust routes for shared agent contracts.",
    details:
      "An interactive field guide with six use cases, protocol exploration, storage and routing diagrams, failure labs, and a runnable Rust runtime example. Examples are anonymized and synthetic.",
    challenge:
      "Keep observed application contracts distinct from production extensions such as scheduling and hardware portability.",
    evidence:
      "Inspectable source and a public interactive guide; no invented performance claims.",
    url: "https://haokun12x.github.io/agentic-systems-fieldnotes/",
    repo: "https://github.com/haokun12x/agentic-systems-fieldnotes",
  },
];
export function projectReadme(p: Project) {
  return `# ${p.title}\n\n${p.summary}\n\nProblem\n${p.problem}\n\nCore idea\n${p.idea}\n\nImplementation\n${p.details}\n\nEngineering challenge\n${p.challenge}\n\nEvidence\n${p.evidence}\n\nProject: ${p.url}\nSource: ${p.repo}\n`;
}
