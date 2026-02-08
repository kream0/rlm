# Recursive Language Models in ADK

**Source:** [https://discuss.google.dev/t/recursive-language-models-in-adk/323523](https://discuss.google.dev/t/recursive-language-models-in-adk/323523)
**Author:** liamconnell
**Date:** January 23, 2026, 9:56 PM
**Category:** Google Cloud > Community Articles
**Tags:** adk, googler-article, ai-ml, developer-tools
**Likes:** 10
**Replies:** 0

---

## Implementing and extending the most exciting Agentic Paradigm of 2026

Recursive Language Models (RLM) is a promising architecture proposed by Alex Zhang and colleagues at MIT. In their paper, published at the very end of 2025, they proved that this model architecture could scale to extremely long context lengths (10M+ tokens) and perform well on information-dense tasks that other architectures struggle with.

## Brief summary of RLM

Recursive Language Models (RLM) push the frontier of agent autonomy by providing the agent complete control of its own context. Rather than feeding context directly to a language model, and facing limitations around context length and long-context reasoning quality, RLMs allow the agent to manipulate the context itself by controlling an interactive coding environment ("REPL"). Importantly, this REPL comes loaded with a few pre-defined variables and functions.

- A variable, `context`, contains the entire context (up to 10M+ tokens). In Zhang et. al's paper, this variable was simply a long string of text.

- A function, `rlm_agent(query, context) -> response`, that invokes a child agent. The child agent's architecture is identical to the current agent's, thus the "recursive" nature of the system.

- A few pre-loaded python libraries (json, re, numpy, etc).

The agent writes python code using these objects, executes it, looks at the results (print statements in the code) and repeats.

[Image: Diagram from Zhang et al. (2025) showing the RLM system architecture. Licensed under CC BY 4.0.]

This is really two concepts rolled into one. First, is the concept of manipulating the context in a code environment. If a user asks "how many times is Gemini mentioned in this giant block of text" the agent can simply write a regex statement and print the result.

Second is the concept of recursive agents and task delegation. Many tasks require more than regex scripts; the agent will have to read the context itself. This typically presents a problem when the context is very long, but an RLM can split the task into sub-tasks and delegate them to child agents to perform. In the simplest case, an RLM splits the context into smaller parts and sends each one to a child agent, aggregating the results of each child agent task.

And delegation is not limited to context decomposition, but can also be applied to **task decomposition**. When an agent invokes the `rlm_agent` function, it sets both the query (i.e., task definition) and the context that the child agent will receive. This allows RLMs to take on another limitation of modern LLMs: reasoning.

Modern LLMs reason by generating streams of text about the problem before coming to a final answer. This has proven incredibly powerful, but is inherently limited by context length. Eventually, there will be a problem that cannot be solved within the context limits of a single language model. Task decomposition via recursive delegation allows the agent to hand off tasks to other agents without burning its own precious reasoning tokens.

## OOLONG-Pairs benchmark and difficult problems

How do we know this all works? The authors created a novel benchmark that measures performance on a particularly difficult type of task. The benchmark is called OOLONG-Pairs, and it sets up very long context windows and requires the model to reason across pairs of statements scattered in the document.

To make a real-world analogy, imagine trying to identify every factual contradiction across a large set of interviews. It would require cross referencing every statement with every other statement. In algorithmic terms, this would be called "quadratic," and for most AI architectures, it would be impossible.

The OOLONG-Pairs benchmark confirms this, with RLM scoring modestly (23/100) and other agents scoring 0.

[Image: Benchmark results visualization showing RLM scoring 23/100 versus competitors at 0.]

The architecture is still in its early stages, and the authors note several promising routes of further developments. In my opinion, many practitioners have already been using some of these concepts with coding CLI agents (e.g., Claude Code, Gemini CLI), by enabling those tools to call child instances of themselves ("sub-agents"). I would love to see the Gemini CLI's or Claude Code's performance on OOLONG-Pairs, which was not included in the paper.

## Implementing RLM in ADK

**Google's Agent Development Kit** (ADK) is an open-source, modular framework designed to simplify the creation and deployment of production-ready AI agents. It provides a code-first approach to building multi-agent systems, handling the heavy lifting of event orchestration, state/session management, and tool integration so developers can focus on custom logic. It was therefore the perfect choice for re-implementing the original RLM codebase in a more enterprise-ready format.

The re-implementation tested the limits of ADK's primitive objects at times. ADK provides a built-in LLMAgent that works for most use cases: it can handle tool calls, sub-agent delegation, response streaming and other common patterns. But the recursive nature RLMs ended up being too twisted even for the LLMAgent and was implemented on top of the more bare-bones BaseAgent. The event streaming and session management systems also needed to be modified slightly. Having worked extensively with ADK since it was released, I was reminded of Picasso's quote: "learn the rules like a pro, so you can break them like an artist".

Ultimately the framework proved flexible enough to elegantly house the RLM. This enables a wealth of features like ADK's evaluation framework, developer UI, API, ease of deployment, integration, session management. Although the concept of RLM is still in its infancy, the code was ready for the big leagues.

## Novel extensions of RLM

### Lazy loading files

The RLM paper assumes that the large context object is a long string of text. However, this isn't the form that we typically find large context. We find it on our file system, enterprise document management systems (like Google Drive and Sharepoint), and other data sources. In theory, these could be loaded into memory for an RLM to operate on, but in practice that's often impractical or impossible -- downloading the entire contents of a company's Google Drive is impossible. So if we have faith that RLMs can extend to extremely long contexts, it's worth considering how we can make this practical.

We can solve this by modifying the nature of the context object and introducing a "Lazy File Loading" pattern. When an RLM agent is instantiated, it contains a reference to a collection of files. It can invoke methods on that object in order to read metadata about its contents and the contents themselves.

Our ADK implementation includes this, supporting files on the local filesystem and in GCS buckets. It can easily be extended to other connected document and data systems.

### Parallelism

The authors note that they run their sub-agents sequentially. This was likely a decision made in order to avoid hitting quota limits from major providers. However, in enterprise systems, users have time constraints on their tasks, and so we added parallelism, with a configurable limit on the maximum number of concurrent tasks (globally).

### Real time UI visualization

Sometimes, a user might want to check in on the progress of a long-running task in order to validate that an appropriate approach is being followed. Our implementation enables this with real-time streaming of events, and a custom UI that displays them.

---

## Links Referenced in Post

- **Original RLM paper:** [https://arxiv.org/abs/2512.24601](https://arxiv.org/abs/2512.24601)
- **ADK implementation (open-source):** [https://github.com/LiamConnell/adk-python/tree/66a757f5/contributing/samples/rlm](https://github.com/LiamConnell/adk-python/tree/66a757f5/contributing/samples/rlm)
- **Original RLM codebase:** [https://github.com/alexzhang13/rlm](https://github.com/alexzhang13/rlm)
- **CC BY 4.0 License (for images):** [https://creativecommons.org/licenses/by/4.0/](https://creativecommons.org/licenses/by/4.0/)

---

## Related Topics (listed on page)

- "Building intelligent Web3 trading agents with Google's Agent Development Kit" (570 views)
- "Building a Transcript Summarization Agent with Google ADK and Vertex AI for Call Centers" (289 views)
- "Using Google's Agent Development Kit (ADK) with MCP Toolbox and Neo4j" (2,858 views)
