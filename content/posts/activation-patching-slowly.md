---
title: Activation patching, slowly
subtitle: What the normalised patching score actually measures, and three ways it quietly misleads.
description: Part two of a slow walk through interpretability tools. The maths behind activation patching, what a score of 0.6 does and doesn't mean, and the failure modes worth checking for.
date: 2026-11-17
tags: [machine learning, interpretability, maths]
series: Interpretability, slowly
seriesOrder: 2
---

> [!EPISTEMIC] Epistemic status
> Working notes. The definitions are standard; the section on how the score misleads is my own synthesis and probably incomplete.

> [!TLDR]
> - Patching copies one activation from a clean run into a corrupted run and measures how much of the behaviour comes back.
> - The normalised score is a ratio of logit differences, so nothing stops it going above 1 or below 0.
> - A high score says an activation is *sufficient to restore* the behaviour in this setup, not that it is the whole mechanism.

In [[reading-the-residual-stream]] I gave activation patching one paragraph. It deserves more, because it is the tool that most often gets quoted as evidence, and the number it produces is easy to over-read.

## The setup

Take two prompts that differ in exactly the way you care about: a clean prompt $x_c$ where the model gets the answer right, and a corrupted prompt $x_r$ where the relevant information has been swapped out. Pick a metric. The usual one is the logit difference between the correct answer $A$ and a plausible wrong answer $B$:

$$
\Delta(x) = \ell_A(x) - \ell_B(x)
$$

Now run the model on $x_r$, but at one site (a head output, an MLP output, the residual stream at some layer and position) replace the activation $h$ with the value it had on the clean run. Write the result as $\Delta(x_r;\, h \leftarrow h_c)$.

### The normalised score

To compare sites, rescale so that the corrupted run sits at 0 and the clean run sits at 1:

$$
S(h) = \frac{\Delta(x_r;\, h \leftarrow h_c) - \Delta(x_r)}{\Delta(x_c) - \Delta(x_r)}
$$

A score near $0$ means patching that site changed nothing. A score near $1$ means that one activation was enough to bring the clean behaviour back.

### Why it can leave $[0, 1]$

Nothing in the formula bounds it.[^1] If the patched activation pushes the correct logit further than the clean run ever did, $S > 1$. If it moves the model away from the clean answer, $S < 0$. Both happen in practice, and both are informative rather than errors.

![A typical layer × position heat map. Each cell is one patch; darker means a higher normalised score.](/images/patching-grid.svg)

## Three ways the score misleads

1. **Sufficiency is not necessity.** Patching *in* a clean activation tests whether it is enough to restore behaviour. It says nothing about whether the model needs it. For that you ablate: remove the activation from the clean run and see what breaks.
2. **The corruption defines the question.** Swapping names asks "where does the model track which name is which?" Replacing names with random tokens asks something broader. The same model gives different heat maps for each, and neither is the "real" one.
3. **Distributed mechanisms hide.** If ten heads each contribute a tenth of the effect, every single-head patch scores around $0.1$ and the map looks empty. Patch groups of components before concluding nothing is there.[^2]

<details>
<summary>Derivation: why the last-layer, last-position residual patch always scores 1</summary>

At the final layer and final position, the residual stream is the only input to the unembedding. Patching the whole stream there copies everything the logits depend on, so

$$
\Delta(x_r;\, h \leftarrow h_c) = \Delta(x_c) \quad\Rightarrow\quad S(h) = 1.
$$

That makes it a free sanity check: if this cell is not exactly 1, the hooks are wired wrong.

</details>

## A sanity-check harness

Before trusting any heat map, I now run the same three assertions:

```python
def normalised_score(patched: float, clean: float, corrupted: float) -> float:
    return (patched - corrupted) / (clean - corrupted)

assert abs(normalised_score(clean, clean, corrupted) - 1.0) < 1e-6      # full patch → 1
assert abs(normalised_score(corrupted, clean, corrupted)) < 1e-6        # no patch   → 0
assert abs(clean - corrupted) > 1.0, "denominator too small to trust"   # signal exists
```

> [!WARNING] Watch the denominator
> If $\Delta(x_c)$ and $\Delta(x_r)$ are close, the denominator is tiny and every score turns into noise. Check $|\Delta(x_c) - \Delta(x_r)|$ before reading anything into the colours.

> [!QUOTE] note to self
> A patching score is a statement about this pair of prompts, this metric and this site. Quote it with all three attached.

[^1]: It's a ratio of two differences, and only the denominator is fixed by the clean and corrupted runs. The numerator depends on what the patch does, which can overshoot in either direction.

[^2]: Path patching, which restricts a patch to particular routes between components, is the usual next step when single-site patching comes back diffuse.
