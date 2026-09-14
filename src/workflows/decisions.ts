interface Decision {
  variable: number;
  choices: number[];
}

export class Decisions {
  private readonly nodes: Decision[] = [{ variable: Infinity, choices: [] }, { variable: Infinity, choices: [] }];
  private readonly unique = new Map<string, number>();
  private readonly cache = new Map<string, number>();

  outcome(variable: number, choice: number): number {
    return this.node(variable, Array.from({ length: 5 }, (_, index) => Number(index === choice)));
  }

  and(left: number, right: number): number { return this.apply('and', left, right); }
  or(left: number, right: number): number { return this.apply('or', left, right); }
  not(value: number): number {
    if (value < 2) return 1 - value;
    const key = `not:${value}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const node = this.nodes[value]!;
    const result = this.node(node.variable, node.choices.map(choice => this.not(choice)));
    this.cache.set(key, result);
    return result;
  }
  implies(left: number, right: number): boolean { return this.and(left, this.not(right)) === 0; }

  private node(variable: number, choices: number[]): number {
    if (choices.every(choice => choice === choices[0])) return choices[0]!;
    const key = `${variable}:${choices.join(',')}`;
    const existing = this.unique.get(key);
    if (existing !== undefined) return existing;
    const id = this.nodes.length;
    this.nodes.push({ variable, choices });
    this.unique.set(key, id);
    return id;
  }

  private apply(operator: 'and' | 'or', left: number, right: number): number {
    if (left === right) return left;
    if (operator === 'and') {
      if (left === 0 || right === 0) return 0;
      if (left === 1) return right;
      if (right === 1) return left;
    } else {
      if (left === 1 || right === 1) return 1;
      if (left === 0) return right;
      if (right === 0) return left;
    }
    const key = `${operator}:${Math.min(left, right)}:${Math.max(left, right)}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const a = this.nodes[left]!;
    const b = this.nodes[right]!;
    const variable = Math.min(a.variable, b.variable);
    const result = this.node(variable, Array.from({ length: 5 }, (_, index) => this.apply(operator, a.variable === variable ? a.choices[index]! : left, b.variable === variable ? b.choices[index]! : right)));
    this.cache.set(key, result);
    return result;
  }
}
