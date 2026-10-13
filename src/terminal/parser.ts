export type Token = { value: string; operator: boolean };
export function tokenize(input: string, env: Record<string, string>): Token[] {
  const tokens: Token[] = [];
  let word = "",
    started = false,
    quote = "";
  const flush = () => {
    if (started) tokens.push({ value: word, operator: false });
    word = "";
    started = false;
  };
  for (let i = 0; i < input.length; i++) {
    let c = input[i];
    if (c === "\\" && quote !== "'") {
      if (i === input.length - 1) throw Error("trailing escape");
      word += input[++i];
      started = true;
      continue;
    }
    if (c === '"' || c === "'") {
      if (!quote) {
        quote = c;
        started = true;
        continue;
      }
      if (quote === c) {
        quote = "";
        continue;
      }
    }
    if (!quote && /\s/.test(c)) {
      flush();
      continue;
    }
    if (!quote && [";", "&", "`"].includes(c))
      throw Error(
        "This shell supports pipelines and redirection; control operators and command substitution are unsupported.",
      );
    if (!quote && ["|", ">", "<"].includes(c)) {
      let op = c;
      if (c === ">" && word === "2") {
        word = "";
        started = false;
        op = "2>";
      } else flush();
      if (c === ">" && input[i + 1] === ">") {
        op += ">";
        i++;
      }
      tokens.push({ value: op, operator: true });
      continue;
    }
    if (c === "$" && quote !== "'") {
      let key = "";
      if (input[i + 1] === "{") {
        const end = input.indexOf("}", i + 2);
        if (end < 0) throw Error("unclosed variable expansion");
        key = input.slice(i + 2, end);
        i = end;
      } else {
        const m = input.slice(i + 1).match(/^(\?|[A-Za-z_]\w*)/);
        if (m) {
          key = m[0];
          i += key.length;
        } else {
          word += "$";
          started = true;
          continue;
        }
      }
      word += env[key] || "";
      started = true;
      continue;
    }
    word += c;
    started = true;
  }
  if (quote) throw Error("unclosed quote");
  flush();
  return tokens;
}
export type Command = {
  args: string[];
  input?: string;
  output?: string;
  error?: string;
  append: boolean;
  errorAppend: boolean;
};
export function parse(input: string, env: Record<string, string>): Command[] {
  const tokens = tokenize(input, env);
  if (!tokens.length) return [];
  const pipeline: Command[] = [];
  let cmd: Command = { args: [], append: false, errorAppend: false };
  const push = () => {
    if (!cmd.args.length) throw Error("expected command");
    pipeline.push(cmd);
    cmd = { args: [], append: false, errorAppend: false };
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t.operator) {
      cmd.args.push(t.value);
      continue;
    }
    if (t.value === "|") {
      push();
      continue;
    }
    const file = tokens[++i];
    if (!file || file.operator) throw Error("redirection needs a filename");
    if (t.value === "<") cmd.input = file.value;
    else if (t.value.startsWith("2")) {
      cmd.error = file.value;
      cmd.errorAppend = t.value === "2>>";
    } else {
      cmd.output = file.value;
      cmd.append = t.value === ">>";
    }
  }
  push();
  return pipeline;
}
