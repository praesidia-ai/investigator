# Investigator development

This is an independent open-source component. Keep runtime imports independent
of sibling Praesidia repositories. The canonical component gate is `npm run check`;
the existing workspace gate has a fixed list of legacy component names.

- Use TypeScript ESM, explicit `.js` imports, strict runtime schemas and narrow modules.
- Treat imported evidence, tool arguments and model responses as untrusted input.
- Keep claim verdict, execution status, evidence integrity and human acceptance distinct.
- Reference checks observe effects; a refusal message or broken target cannot prove prevention.
- Preserve positive-control tests so denying all work cannot count as a repair.
- Keep model and Praesidia credentials outside evidence, tool arguments and reports.
- Provider failures never silently switch to the scripted reference provider.
- Run checks serially from this component. Do not start or mutate the shared stack.
- Do not commit, push, publish or deploy unless the user explicitly requests it.
