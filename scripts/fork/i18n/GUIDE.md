# Portuguese (Brazil) translation guide

LearnHarness is a desktop app for learning with an AI tutor. The learner runs teaching sessions and practice sessions with a "teacher" agent. A "prober" agent first checks what they already know. The app has quizzes and problems, a plan of the lesson, background helper agents (researcher, figure maker, demo builder, PDF reader, extractor), and a knowledge graph of what the learner knows (nodes, reasoning chains, clusters). Settings cover model providers, API keys, subscriptions (Claude, ChatGPT, Copilot, Grok), appearance, graph physics and keyboard shortcuts.

The interface is written in English. `src/core/i18n/catalog/pt-BR.json` maps each English text, exactly as the interface shows it, to its Portuguese text, and the app swaps them at runtime. Keys must therefore stay byte-identical to the English. `scripts/fork/i18n/sync.ts` sends this guide to Claude Code along with each new text, its source location and the surrounding code.

## How to translate

- Use natural, concise Brazilian Portuguese, the way a polished Brazilian app reads. Keep a similar length: buttons and labels are small. Address the learner as "você", or use the imperative ("Verifique", "Tente novamente").
- Use sentence case, never Title Case: "Check for updates" becomes "Verificar atualizações". Keep ALL CAPS strings in ALL CAPS. Keep lowercase fragments lowercase.
- Keep leading and trailing decorations exactly: "· ", "— ", "…", "→", "↗", "✓", a trailing ":", "?" or ".".
- Placeholders `{0}`, `{1}`, … stand for values filled in at runtime (numbers, names, versions, durations). Every placeholder must appear exactly once in the output. You may reorder them.
- Strings with placeholders may also be split in the UI. For example "{0} steps" can render as the text node "12 steps", and "· {0} sources" as "· 3 sources". Translate them as whole phrases ("{0} passos", "· {0} fontes").
- **Fragments.** Some strings are pieces of a sentence assembled in JSX, such as "is ready", "update", "of", "in /", "as", "s" (a plural suffix) or "page". Look at the code shown with them to see how they combine, then pick translations that read well once assembled. When no sensible standalone translation exists, return the string unchanged.
- **Keep unchanged** (return the identical string): brand and product names (LearnHarness, Learning Harness, Claude, Claude Code, ChatGPT, OpenAI, Anthropic, Deepgram, Tavily, Brave, Brave Search, GitHub Copilot, Grok, Groq, Mistral, Google, Hugging Face, …), font names, terminal commands, URLs, file names, keyboard key names (Esc, Enter, Shift, Ctrl, Alt, ⌘) and "PDF" / "SVG" / "HTML" / "API".
- **null:** output `null` for strings the learner never sees: log lines, developer-only errors such as "X components must be used within X", internal validation messages naming code fields, and text sent only to the AI model.
- Error messages the learner can see should be clear and polite: "Try again" becomes "Tente novamente".

## Glossary (use consistently)

| English | Português (Brasil) |
| --- | --- |
| session / teaching session / practice session | sessão / sessão de ensino / sessão de prática |
| lesson | aula |
| teacher / tutor | professor / tutor |
| prober (agent) / probing (phase) | sondador / sondagem |
| teaching (phase) | ensino |
| learner | aluno |
| quiz / question / answer / option | quiz / pergunta / resposta / opção |
| problem (practice) | problema |
| hint / hint rung | dica / nível de dica |
| recall / free recall / multiple choice | recordação / recordação livre / múltipla escolha |
| check (a quick check of understanding) | verificação |
| confidence | confiança |
| I don't know | Não sei |
| dismiss / discard / abort / skip | dispensar / descartar / interromper / pular |
| steer (the lesson) | direcionar |
| plan / plan node | plano / nó do plano |
| knowledge graph / graph | grafo de conhecimento / grafo |
| node / edge / cluster / chain / reasoning chain | nó / aresta / agrupamento / cadeia / cadeia de raciocínio |
| proposition | proposição |
| region | região |
| extraction / extract / extractor | extração / extrair / extrator |
| coverage | cobertura |
| compaction / compact / context compacted | compactação / compactar / contexto compactado |
| context (model context window) | contexto |
| researcher / research / research brief | pesquisador / pesquisa / relatório de pesquisa |
| brief (a helper's written result) | relatório |
| figure / figure maker | figura / criador de figuras |
| demo / demo builder / interactive demo | demonstração / criador de demonstrações / demonstração interativa |
| PDF reader | leitor de PDF |
| sub-agent / background agents | subagente / agentes em segundo plano |
| job (background task) | tarefa |
| turn (one agent reply cycle) | turno |
| thinking (model reasoning) / thinking level | raciocínio / nível de raciocínio |
| Thinking… (status) | Pensando… |
| your thinking (the learner's written reasoning) | seu raciocínio |
| provider / API key / key | provedor / chave de API / chave |
| model / model tier / Strong / Cheap / Vision | modelo / nível de modelo / Forte / Econômico / Visão |
| subscription / plan (paid plan) | assinatura / plano |
| connect / disconnect / connection | conectar / desconectar / conexão |
| sign in / sign-in / signed in / sign out | entrar / login / conectado / sair |
| account / workspace | conta / workspace |
| background use | uso em segundo plano |
| usage / usage limit / cost / unpriced | uso / limite de uso / custo / sem preço |
| tokens / tok | tokens / tok |
| settings / Providers / Agent / Appearance / Graph / Keyboard / General | Configurações / Provedores / Agente / Aparência / Grafo / Teclado / Geral |
| system prompts / instructions | prompts de sistema / instruções |
| shortcut / rebind | atalho / redefinir atalho |
| update / check for updates / release notes / restart | atualização / verificar atualizações / notas da versão / reiniciar |
| find / match / next match | localizar / ocorrência / próxima ocorrência |
| import notes | importar notas |
| dictation / dictate | ditado / ditar |
| sidebar | barra lateral |
| home | início |
| rename / delete / save / cancel / retry / continue / done / close / open | renomear / excluir / salvar / cancelar / tentar novamente / continuar / concluído / fechar / abrir |
| loading… / saving… / working… | carregando… / salvando… / trabalhando… |
| just now / {0}m ago / {0}h ago / {0}d ago | agora mesmo / há {0} min / há {0} h / há {0} d |
| physics (graph layout forces): repulsion, attraction, pull, friction | física: repulsão, atração, atração (pull), atrito |
