# Judge My Letterboxd

Dois aplicativos independentes que compartilham o contrato `presentation-v1`:

| Aplicativo | Runtime | Entrada | Execução |
| --- | --- | --- | --- |
| Web | HTML/CSS/JS + Cloudflare Pages Functions | Upload no navegador | ZIP → parser JS → análise JS → Gemini → Presentation Script |
| Local | Python via `app.py` | ZIP no computador | Pipeline Python completo → Presentation Script + auditoria local |

O Cloudflare não executa, importa ou chama `app.py`. A aplicação local continua
funcionando por conta própria, mesmo que o site não esteja publicado.

## Frontend web

```powershell
python -m http.server 8080 --bind 127.0.0.1
```

Abra http://localhost:8080 e http://localhost:8080/?demo=1. Não use `file://`.
Esse servidor testa apenas os assets e a demo. Para testar upload e IA, use Wrangler,
pois `/api/judge` é executado como Pages Function.

### Arquitetura e reprodução

- `index.html`, `css/`: landing, upload, loading, narrativa e final; identidade original,
  fontes do sistema, layout estreito, teclado e reduced motion.
- `js/app.js`: estados e cancelamento; `api.js`: multipart `export` + `locale`,
  timeout e erros; `upload.js`: extensão, assinatura ZIP e limite inicial de 50 MB.
  A Function repete a validação no servidor antes de processar o arquivo.
- `chat-renderer.js` e `animations.js`: fila assíncrona, digitação rápida, raros erros
  cosméticos corrigidos e strike sem Markdown. Não existe controle de pausa, velocidade
  ou skip: a IA dirige o ritmo pelos enums `short`, `medium` e `long`, e as evidências
  ficam no ar tempo suficiente para serem lidas (`readWait` cresce com o texto, com teto
  em `timing.readMax`). O `messageGap` mantém as falas espaçadas. Ao subir a página, o
  acompanhamento automático para.
- `event-renderer.js`: evidências tipadas, sem HTML da IA; reviews estruturadas
  são construídas com elementos seguros, então um `<blockquote>` do export vira um
  `blockquote` de verdade em vez de texto literal. Eventos desconhecidos são ignorados.
- `i18n.js`: interface pt-BR/en-US, com detecção do navegador e um `details`/listbox
  próprio no header (sem `<select>` nativo). O roteiro nunca é traduzido.
- `opening.top_four` contém identidade dos favoritos; `cue: top_four_reveal` na
  mensagem de apresentação dispara a faixa antes de `role: archetype_phrase`.
  A faixa permanece no histórico. Zero a quatro favoritos são suportados.
- `poster-service.js`: URL fornecida → memória/localStorage (7 dias) → `/api/poster` →
  cartaz abstrato com título e ano. Um `resolved: false` definitivo fica no cache da
  sessão; falha transitória (rede, 429, 5xx) não fica, então o próximo cartão daquele
  filme tenta de novo. Resolução lazy por proximidade do viewport; só favoritos são
  antecipados. Falhas não interrompem o player.
- `images/camera-reels-fill.svg` é o ícone do site: o mesmo arquivo é o favicon
  (`rel="icon"`), a marca do header, o chip do export escolhido e o símbolo do cartaz
  abstrato, sempre carregado como `<img>` por `icon()` em `utils.js`. Um asset só, sem
  gradiente duplicado no DOM.
- `functions/api/poster.js`: consulta TMDB no servidor com o idioma do visitante, aceita
  título (ou título original) normalizado e escolhe o ano de lançamento mais próximo —
  exato, com um ano de tolerância entre festival e lançamento — desempatando pelo mais
  popular. Se nada casar, repete sem o filtro de ano antes de desistir; a resposta traz
  `reason` (`missing_tmdb_key`, `tmdb_error`, `tmdb_unreachable`, `no_match`,
  `invalid_query`) para diagnosticar direto em
  `/api/poster?title=Young%20Hearts&year=2024`. Cache HTTP de 7 dias para sucesso e curto
  para falhas. Nenhum rating ou evidência é alterado.
- `functions/api/judge.js` e `functions/_lib/`: backend web independente. Descompacta
  o ZIP com APIs do runtime Workers, interpreta os CSVs, calcula estatísticas e
  momentos editoriais, chama Gemini com saída estruturada e monta o Presentation Script.
  Não há dependência de Python, subprocesso ou serviço externo próprio.

  A resposta do modelo nunca vira roteiro sem validação: JSON cortado pelo limite de saída
  é reparado, campos de ritmo ausentes usam padrões e cada rejeição volta para a IA com o
  motivo e os ids que faltam. Se nada utilizável chegar, o julgamento sai parcial
  (`render.ai_generation: partial`, `quality_degraded: true`, `ai.warnings`) com todas as
  evidências, em vez de uma tela de erro; só resposta ilegível em todas as tentativas é
  reportada como erro de formato.



### Atualizar a demo

```powershell
python app.py
python scripts/update-demo.py
```

A fixture deriva da saída real, preservando falas e evidências. O script remove
diagnósticos e metadados internos de IA. Para outputs legados `opening_v1`, recupera
os favoritos de `final_writer_request.json` e marca as posições estruturais da
abertura, sem comparar textos. Não altera `output/`. A fixture contém nome público,
filmes e trechos reais de reviews: revise seu conteúdo antes de publicar.

### Cloudflare Pages

Use o repositório, branch `main`, root directory `/`, build command
`python scripts/prepare-web.py` e output directory `dist`. Esse comando só copia
uma lista permitida de assets; não transpila nem empacota JavaScript. **Não publique
a raiz do repositório**, pois contém exports e outputs locais. Não coloque arquivos
privados em `dist/`. `functions/` fica na raiz, como esperado pelo Pages.

```powershell
python scripts/prepare-web.py
npx wrangler pages dev dist
# Depois de criar/configurar seu projeto Pages:
npx wrangler pages deploy dist --project-name judge-my-letterboxd
```

O `_routes.json` envia `/api/*` e as páginas públicas `/@*` às Functions. Resultados
compartilháveis usam D1: crie o banco, aplique `migrations/0001_public_results.sql` e
associe-o ao Pages com o binding `RESULTS_DB` (veja `wrangler.example.toml`). A chave
única `(profile_key, judge_number)` evita numeração duplicada sob concorrência. As
páginas individuais usam `noindex,follow`: continuam compartilháveis, mas não entram
no sitemap nem transformam perfis pessoais em índice público pesquisável.

Configure `TMDB_API_KEY`
e `GEMINI_API_KEY` como secrets nas configurações do Pages. `GEMINI_MODEL` e
`GEMINI_FALLBACK_MODELS` são variáveis opcionais; os padrões formam uma cadeia entre
`gemini-flash-latest`, `gemini-3.8-flash` e `gemini-3.5-flash-lite`. Configure os secrets nos
ambientes Production e Preview que você usa e faça um novo deploy. Eles ficam em
`context.env` da Function e nunca são enviados ao navegador.

Para desenvolvimento local, copie `.dev.vars.example` para `.dev.vars`, preencha as
chaves e execute:

```powershell
Copy-Item .dev.vars.example .dev.vars
python scripts/prepare-web.py
npx wrangler pages dev dist
```

Abra a URL exibida pelo Wrangler. Não inserir secrets no código público nem commitar
`.env`/`.dev.vars`.
Referências oficiais: [desenvolvimento local](https://developers.cloudflare.com/pages/functions/local-development/),
[rotas](https://developers.cloudflare.com/pages/functions/routing/),
[busca TMDB](https://developer.themoviedb.org/reference/search-movie).

Sem `TMDB_API_KEY` — ou servindo apenas o estático, sem as Pages Functions —
`/api/poster` não resolve e **todo** cartaz usa o fallback abstrato desenhado pelo CSS.
Para conferir um filme específico, abra `/api/poster?title=Título&year=2024`: a resposta
diz `resolved` e, quando não resolve, o `reason`.

### Testes web

```powershell
npm ci
npx playwright install chromium firefox webkit
npm run test:web
# Com o servidor estático na porta 8080 em outro terminal:
npm run test:browser
# Opcional, após instalar os três navegadores:
$env:ALL_BROWSERS='1'; npm run test:browser
```

Playwright é apenas ferramenta de desenvolvimento; o site não tem dependências JS.
`/web-tests/harness.html` exercita todos os tipos, títulos/reviews longos, nota e
pôster ausentes, markup hostil e favoritos. O smoke confere ainda que um membro de
lista ou de tag com nota a mostra, enquanto um filme sem nota continua sem nota.
O smoke automatizado usa 360×800,
390×844, 768×1024, 1366×768 e 1920×1080; screenshots ficam em
`web-tests/artifacts/` (ignorado). O harness não é copiado para produção.

Compartilhamento usa Web Share, clipboard ou download de texto; não há URL persistida.
O SVG de Open Graph é um placeholder: algumas redes exigem PNG/JPEG para preview.
Sem secret TMDB os cartazes usam fallback. Sem `GEMINI_API_KEY`, o upload informa
claramente que falta configurar o Judge web. A demo é pt-BR, mesmo com UI em inglês.
A análise web prioriza uma experiência rápida e não grava o ZIP nem os resultados;
o pipeline Python permanece mais profundo e mantém todos os artefatos de auditoria.

## Princípio: conteúdo é uma coisa, apresentação é outra

O backend escolhe o que é interessante. A IA descobre significado. A interface atua.
Ninguém improvisa coreografia.

- O backend decide quais informações são interessantes (findings determinísticos e
  Editorial Moments display-first).
- O AI Analyst ajuda a descobrir significado (candidatos semânticos com evidência
  citada; nunca escreve o julgamento).
- O Script Engine decide a sequência (seleção, diversidade, papéis, ordem).
- A IA final escreve as falas (uma única chamada para o roteiro inteiro).
- A apresentação é estruturada: `typing`, `pause`, `message`, `correction`, `strike`,
  `profile_stats`, `film`, `film_pair`, `film_group`, `review_quote`, `tag`, `list`,
  `rating`, `rewatch`, `phrase`, `stat`. A IA nunca escreve `~~riscado~~`, `*correção`
  nem milissegundos: efeitos são campos estruturados e durações são enums
  (`instant`, `short`, `medium`, `long`).

Quanto mais expressiva a interface, mais simples pode ser o texto.

## Pipeline

```text
ZIP → parser → perfil unificado → analyzer → findings determinísticos
                                              ↓
                        contexto → AI Analyst (JSON, 1 chamada)
                                              ↓
                               validação de evidências
                                              ↓
                            Finding Pool com origem preservada
                                              ↓
                          Script Engine determinístico
                                              ↓
                     Editorial Moments display-first (o dado já é a cena)
                                              ↓
              AI Writer final — UMA chamada para o roteiro inteiro
                                              ↓
                       Presentation Builder → presentation_script.json
```

Python mede; o Analyst é o editor semântico. Medições determinísticas não viram piada
automaticamente. O Analyst recebe também review_style, review_coverage, rewatches,
listas, tags, likes/watchlist e pode usar cultura cinematográfica estável como ângulo,
sem tratá-la como evidência da conta. O Script Engine escolhe assunto, ordem e modo.
O Writer reage ao roteiro inteiro sem poder mudá-lo. O Presentation Builder traduz tudo em eventos: é o contrato do
frontend futuro, legível sem HTML.

## Instalação

Python 3.11+; no PowerShell, dentro da pasta do projeto:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
Copy-Item .env.example .env
```

Se `.env` já existir, edite-o sem sobrescrever sua chave. Preencha `GEMINI_API_KEY`.
Sem ativação, use `.\.venv\Scripts\python.exe` no lugar de `python`.
Linux/macOS: `source .venv/bin/activate`.

Coloque o ZIP oficial ao lado de `app.py` e execute nessa pasta. Um ZIP é escolhido
automaticamente; vários abrem seleção numerada; ausência gera uma mensagem clara.

```powershell
python app.py
python app.py --dry-run
python app.py --analyze-only
python app.py --no-analyst
python app.py --show-findings
python app.py --show-events
```

- Normal: análise local, uma chamada de Analyst, momentos editoriais e UMA chamada de
  Writer para o roteiro inteiro; o terminal imprime a experiência evento a evento.
- `--dry-run`: nenhuma chamada à IA, mesmo com chave; ainda produz
  `presentation_script.json` com abertura estrutural, dados e silêncio.
- `--analyze-only`: chama Analyst e Script Engine; nunca chama Writer.
- `--no-analyst`: modo de debug local. Pula o Analyst e **não** gera um julgamento
  final; findings determinísticos continuam auditáveis, mas o Writer não finge que
  existe material editorial suficiente.
- `--show-findings`: mostra todos os findings determinísticos.
- `--show-events`: imprime o `presentation_script.json` completo.
- Sem chave: qualquer modo conclui a parte local e informa que pulou a IA.
- `--dry-run` sempre prevalece sobre chamadas à IA.

Uma execução completa faz no máximo **duas chamadas lógicas**: 1 Analyst + 1 Final
Writer. `run_status.json` registra `calls`. Respostas validadas ficam em cache local e
uma segunda execução idêntica não consome cota. Falhas transitórias HTTP
408/429/500/502/503/504 têm até três tentativas dentro da mesma chamada, com atraso
limitado; timeout de 120s por tentativa. HTTP 400 não recebe repetição automática.
Falha no Analyst preserva o roteiro local e pula o Writer; falha no Writer preserva
todos os dados e as falas já aceitas. Saída parcial fica marcada e retorna código 1.

No endpoint web, o Analyst é uma barreira obrigatória: se todos os modelos falharem,
ele retorna `analyst_unavailable` (`stage: analyst`, com `reason` e `attempts`) e o
Writer não é chamado. Seleção determinística sem Analyst existe apenas no modo
explícito de teste. Uma falha real significa "não obtivemos análise" (nenhum modelo
respondeu, credencial, cota/rate limit sem reserva, timeout ou nenhuma resposta
utilizável após repair) — nunca "o modelo trouxe três achados excelentes em vez de
quatro".

Quando o erro é 404/429/5xx, o modelo configurado é trocado pelo próximo da cadeia
antes de desistir, e o modelo que respondeu aparece em `served_model`. Depois de
401/403/429 esgotar toda a corrente, a execução para: insistir com credencial inválida
ou cota esgotada só gasta tempo.

## Quando `judgment.txt` não traz um julgamento

Com IA disponível, `judgment.txt` é a experiência como texto. Sem IA, ele começa com
`[SEM REAÇÃO DE IA NESTA EXECUÇÃO — a estrutura e os dados abaixo são do backend]` e
continua com a abertura estrutural, o reveal de números, os dados dos Editorial
Moments e pausas no lugar das falas. Isso é deliberado: nunca inserimos uma frase
fixa para fingir que houve julgamento. O status real fica em `presentation_script.json`
(`render.ai_generation`), em `run_status.json` e em `final_writer_response.json`.
Execuções anteriores são copiadas para `output/runs/<timestamp>/` antes de qualquer
limpeza.

Motivos mais comuns e o que fazer:

| `run_status.json` | Causa | Ação |
| --- | --- | --- |
| `analyst: failed`, `error.code: 429`, `limit_window: day` | Cota diária (RPD) do modelo esgotada | RPD renova à meia-noite do Pacífico (04h em Brasília); ou usar `GEMINI_FALLBACK_MODELS` com outro modelo (a cota é por modelo e por projeto); ou rodar `--no-analyst` |
| `analyst: failed`, `error.code: 429`, `limit_window: minute` | Limite por minuto | Esperar e repetir; reduzir `SCRIPT_MAX_BEATS` |
| `analyst: failed`, `error.code: 401/403` | Credencial inválida | Conferir `GEMINI_API_KEY` no `.env` |
| `writer: failed`, `error.code: 429` | Cota esgotada na chamada do Writer | A estrutura e os dados continuam em `presentation_script.json`; repetir depois da renovação reaproveita o cache |
| `writer: rejected`, `error.reason: final_writer_contract` | A resposta do Writer violou o contrato (beat novo, efeito inválido, número solto, markdown) | Nenhum texto é aceito; ver `final_writer_response.json.errors` |

## Configuração

Variáveis de ambiente prevalecem sobre `.env`. Nenhuma chave é gravada nos outputs.

| Variável | Default | Uso |
| --- | --- | --- |
| `GEMINI_API_KEY` | vazio | Chave do Gemini |
| `GEMINI_MODEL` | `gemini-flash-latest` | Compatibilidade: modelo usado quando a variável específica da etapa não foi definida |
| `GEMINI_ANALYST_MODEL` | herda `GEMINI_MODEL` | Modelo principal do Analyst |
| `GEMINI_ANALYST_FALLBACK_MODELS` | herda fallback legado | Reservas do Analyst |
| `GEMINI_WRITER_MODEL` | herda `GEMINI_MODEL` | Modelo principal do Final Writer |
| `GEMINI_WRITER_FALLBACK_MODELS` | herda fallback legado | Reservas do Writer; variantes Lite são rebaixadas para o fim pelo discovery |
| `GEMINI_FALLBACK_MODELS` | vazio | Compatibilidade para as duas etapas quando fallbacks específicos não foram definidos |
| `JUDGE_LANGUAGE` | `pt-BR` | Idioma das observações e reações |
| `MAX_CONTEXT_CHARS` | `1000000` | Prompt + dados do Analyst |
| `SCRIPT_MAX_BEATS` | `12` | Máximo entre 1 e 14; quality gate pode resultar em menos |
| `WRITER_MAX_CONTEXT_CHARS` | `100000` | Prompt + dossier editorial + roteiro inteiro em UMA chamada Writer |
| `WRITER_MAX_LINES` | `4` | Teto global por beat; normalmente 1–3 linhas |
| `WRITER_MAX_WORDS_PER_LINE` | `14` | Teto rígido; linhas continuam curtas |
| `ANALYST_TEMPERATURE` | `0.2` | Temperatura independente |
| `WRITER_TEMPERATURE` | `0.75` | Temperatura independente |
| `MODEL_DISCOVERY` | `1` | Descoberta dinâmica via `models.list` antes do Writer |
| `MODEL_DISCOVERY_CHAIN_LIMIT` | `8` | Quantos modelos de reserva entram na corrente; Flash-Lite fica por último |
| `MODEL_DISCOVERY_TTL_MINUTES` | `30` | Validade do cache local de descoberta (desligado por padrão no fluxo) |
| `JUDGE_HUMOR_TEMPLATES` | `0` | `1` habilita momentos HUMAN_TEMPLATE quando o template casar |
| `WRITER_MAX_LINES` | `3` | Máximo entre 1 e 3 linhas geradas por beat |
| `WRITER_MAX_WORDS_PER_LINE` | `24` | Teto rígido; preferência de estilo: 2–12 |
| `ANALYST_TEMPERATURE` | `0.2` | Temperatura independente |
| `WRITER_TEMPERATURE` | `0.7` | Temperatura independente |

Limites de caracteres não são estimativas de tokens. O envelope/schema da SDK não
entra nessa contagem. Evidência grande demais para um beat é excluída da seleção,
com motivo registrado, sem truncar silenciosamente. O pedido Writer final também
é conferido antes da chamada.

Os únicos pacotes diretos são `google-genai`, `python-dotenv` e `rich`. Parser e
análise usam biblioteca padrão. A integração usa `from google import genai` e
[JSON Schema na SDK](https://ai.google.dev/gemini-api/docs/structured-output).
Rich é usado conforme a [API de Console](https://rich.readthedocs.io/en/stable/console.html);
textos do export são renderizados literalmente, sem executar markup.
O schema enviado ao provedor mantém campos, tipos e enums; limites de arrays e
faixas são aplicados localmente, pois restrições aninhadas no schema completo
produziram HTTP 400 no modelo configurado durante o teste real.

## Auditoria: por que essa frase apareceu?

Comece pelo beat em `presentation_script.json` (bloco `beats`), siga `finding_ids`
para `editorial_moments.json`, `script.json` e `finding_pool.json`. Em
`final_writer_request.json` está o pedido exato do Writer (o roteiro inteiro que ele
viu) e em `final_writer_response.json` a resposta bruta, o contrato validado ou
recusado, os avisos e as linhas descartadas. Um texto gerado não recebe novas
evidências por ter sido escrito pelo Writer.

| Arquivo | Conteúdo |
| --- | --- |
| `raw_export.json` | Conversão fiel de TODOS os arquivos do ZIP em JSON; não é filtrado editorialmente |
| `extracted_profile.json` | Extração consolidada usada pela lógica determinística |
| `profile_summary.json` | Todas as medições determinísticas |
| `review_style.json` | Frases/aberturas/finais recorrentes, markup e interseções |
| `review_coverage.json` | Matching diary ↔ reviews e sessões sem review |
| `quality_report.json` | Gate editorial do Analyst/Script e qualidade do modelo Writer |
| `editorial_dossier.json` | Contexto global e momentos exatos entregues ao Final Writer |
| `findings.json` / `deterministic_findings.json` | Mesmos candidatos estatísticos, com sample_size, metric, baseline, difference e fontes |
| `ai_id_map.json` | Mapa da chave canônica local para IDs curtos de filmes |
| `ai_context.json` | Mensagem de dados exata do Analyst; coverage registra omissões |
| `ai_request.json` | Pedido exato do Analyst, incluindo prompt, schema, modelo e temperatura |
| `ai_response.json` | Resposta serializada da SDK para o Analyst, se houve resposta |
| `analyst_response.json` | Texto JSON bruto retornado e versão do prompt |
| `semantic_findings.json` | Somente candidatos aceitos, com evidências resolvidas |
| `semantic_validation.json` | Rejeitados com motivos; não entram no pool |
| `finding_pool.json` | Findings normalizados, mantendo origin deterministic ou semantic |
| `script.json` | Seleção: ordem, categoria, finding, motivo/penalidades; excluídos com motivo |
| `editorial_moments.json` | Os Editorial Moments selecionados: tipo, papel, display estruturado, evidência, `max_lines`, silêncio permitido |
| `model_discovery.json` | Principal, fallbacks configurados, modelos descobertos, rejeitados com motivo, corrente final e estado da descoberta |
| `final_writer_request.json` | A UMA chamada do Writer: payload completo (o roteiro inteiro), request exato, tamanho e momentos removidos pelo orçamento |
| `final_writer_response.json` | Resposta bruta, `served_model`, tentativas, contrato validado ou recusado, avisos e linhas descartadas |
| `presentation_script.json` | Contrato do frontend: versão, locale, perfil, reveal, aberturas, `render`, `ai`, beats e a lista de `events` |
| `judgment.txt` | Projeção terminal da experiência (eventos em texto), com cabeçalho de status quando não houve IA |
| `run_status.json` | Estado real das etapas, modelo, corrente, `calls`, versões dos prompts, origem (api/cache) e tentativas por modelo |
| `debug_report.txt` | Inventário, avisos, cobertura, descoberta de modelos, render e estado da execução |

`writer_inputs.json` e `judgment.json` não existem mais: as chamadas por beat
desapareceram. O que eles auditavam agora está em `editorial_moments.json`,
`final_writer_response.json` e `presentation_script.json`.

## Abertura: template do Script Engine, slots da IA

A abertura é um template do backend com variação controlada. A IA preenche apenas
slots, dentro de pools localizados:

```text
typing → saudação → typing → "Você deve ser o..." → arquétipo (4 conceitos)
→ pause → "...?" → pause → "Grande demais." → "Pode ser só {nome}."
→ typing → "Me falaram que você tem um" → [strike negativo] → pause
→ [correction negativo→positivo] → "gosto pra filmes."
→ "Mas fala sério." → "Só quem pode julgar isso sou eu."
→ typing → "Deixa eu ver." → typing → "...!" → profile reveal → reação opcional
```

- A saudação é sorteada de um pool pequeno por locale, de forma estável por conta
  (mesma conta, mesma identidade; contas diferentes, identidades diferentes).
- O par de adjetivos vem de `taste_adjective_pairs`: a IA pode escolher um par
  inteiro, nunca misturar palavras de pares diferentes; fora do pool, o par do Script
  Engine é mantido e o descarte fica registrado em `ai.warnings`.
- `top_four_archetype` exige uma frase gramatical curta que componha semanticamente os
  quatro favoritos — nunca uma lista de títulos, rótulo genérico ou diagnóstico da
  pessoa. Se a validação falhar, o bloco e seu card compartilhável são omitidos.
- A reação do reveal é opcional (0 ou 1 linha, no máximo 14 palavras) e só pode citar
  números já exibidos.
- A graça do "título grande demais" é o fracasso deliberado do template: a IA cria o
  título, o Judge percebe, abandona e usa o nome.

## Presentation Script (contrato do frontend)

`presentation_script.json` é independente de HTML e legível como experiência:

```json
{"type": "message", "segments": [{"text": "Me falaram que você tem um "},
                                 {"text": "duvidoso", "effect": "strike"},
                                 {"text": " ótimo", "effect": "correction"}]}
```

Tipos suportados: `typing`, `pause`, `message`, `correction`, `strike`,
`profile_stats`, `film`, `film_pair`, `film_group`, `review_quote`, `tag`, `list`,
`rating`, `rewatch`, `phrase`, `stat`. Durações: `instant`, `short`, `medium`, `long`.
Nenhum evento carrega milissegundos nem Markdown. Um momento pode ter falas vazias:
aí entram só os dados e uma pausa, e isso é decisão de roteiro, não falha.

## Localização e HUMAN_TEMPLATE

- `resources/locales/{pt-BR,en-US}.json`: frases estruturais, pools (saudações,
  pares de adjetivos) e rótulos de estatísticas. Nada é traduzido em tempo de
  execução, e a IA não reinventa a abertura: ela preenche slots.
- `resources/humor/{pt-BR,en}.json`: linhas escritas por gente, marcadas como
  `render_strategy: human_template` e `source: human_template:<id>` em cada beat.
  Desligado por padrão (`JUDGE_HUMOR_TEMPLATES=1` habilita).
- A identidade da conta vem de `profile.csv` (`Username`/`Name`); todo o resto desse
  arquivo continua descartado.

## Descoberta de modelos e fallback

A corrente é montada nesta ordem, sem duplicatas: `GEMINI_MODEL` →
`GEMINI_FALLBACK_MODELS` → modelos descobertos por `models.list` (até
`MODEL_DISCOVERY_CHAIN_LIMIT`). O filtro aceita apenas o que serve para
`generateContent` de texto e rejeita, com motivo registrado, embeddings, TTS, áudio,
imagem, live, transcrição, Lyria, robotics e modelos com ciclo de vida encerrado;
a preferência é Flash estável, depois Flash `latest`, depois Flash-Lite, e preview/experimental
perdem pontos quando há alternativa. A descoberta acontece **uma vez por execução** e
apenas antes do Writer.

Como `models.list` não devolve capacidades para todo projeto, o filtro é heurístico e
documentado; o que escapar é resolvido em tempo de execução: 404/incompatibilidade,
429 ou 5xx levam ao próximo modelo da corrente, com `model_attempts` e
`served_model` gravados. 401/403 é falha global de credencial e para a execução.

## Fallback local (sem IA, sem fingimento)

Sem Analyst, sem chave, em `--dry-run` ou com o Writer recusado, o
`presentation_script.json` continua válido: abertura estrutural (sem arquétipo, que é
slot de IA), reveal de números, todos os Editorial Moments com seus dados, pôsteres
identificados por `film_key` e pausas no lugar das falas. Os campos de reação ficam
vazios e `render.ai_generation` diz `skipped` ou `failed`. Nenhuma frase fixa é
inserida para parecer julgamento.

`render.ai_generation` descreve completude (`complete` ou `partial`), enquanto
`render.model_quality` descreve o modelo servido (`primary`, `fallback` ou
`fallback_lite`). Assim, uma resposta completa de um modelo Lite continua completa,
mas vem com `quality_degraded: true`; `partial` é reservado a conteúdo incompleto.

## Regras de análise e validação

Filmes usam título NFC/casefold/espaços normalizados + ano. URIs são preservadas,
mas não fazem os joins. Homônimos no mesmo ano podem colidir; grafias diferentes
não são resolvidas por inferência. Favoritos usam correspondência local exata de
URI, ignorando barra final; os não identificados ficam sem rating inventado.
Arquivos opcionais ausentes são aceitos; desconhecidos são inventariados.
`deleted/` e `orphaned/` nunca entram no perfil ativo. CSV de listas detecta o
header de filmes após o bloco de metadados. Limites de ZIP: 50 MB por CSV conhecido,
200 MB de tamanho descompactado declarado. Espera-se o layout oficial na raiz.

Rating atual vem de `ratings.csv`, mesclado por último: uma linha de diary ou de review
guarda a nota daquela sessão ou daquele texto, não sobrescreve a nota atual e só
preenche um filme que não tem linha em `ratings.csv`. Rating de sessão vem só daquela
linha de diary; rating de review vem daquela review. Null nunca é preenchido com outro
rating. Cartões de lista e de tag mostram a nota atual do filme, resolvida pelo registry:
o CSV de lista não tem coluna de nota e uma linha de diary carrega só a nota daquela
sessão, então sem essa consulta todo membro avaliado aparecia como "Sem nota" ali.
Reviews não criam sessões. Rewatches explícitos e repetições observadas são separados;
não se somam. Sessões no mesmo dia ou sem data não sustentam direção cronológica.

Tags mantêm métricas separadas: `current_film_ratings` usa filmes únicos e
`session_ratings` usa somente sessões avaliadas do diário, sem somar reviews.
`ratings` no debug local é o alias legado da primeira. Findings contextuais usam
exclusivamente média de sessões, comparada à média de todas as sessões avaliadas.
Exigem pelo menos 5 sessões avaliadas e 3 filmes distintos. Associação não é causa.
Overlaps de tags são por filmes únicos (não necessariamente na mesma sessão),
com mínimo de 3 por tag e 3 em comum, Jaccard >= .3 ou inclusão >= 80%, até 50 pares.

Comprimentos brutos e sem HTML são mantidos; palavras/ngrams ignoram HTML. Reviews
curtas têm até 5 palavras; longas atingem 500 caracteres e percentil 90. Padrões de
escrita exigem pelo menos max(3, round(3% das reviews)) textos distintos, ngrams
3–5 e aberturas de 4 palavras, com filtro de palavras funcionais e até 30 padrões.
Score continua heurístico e transparente: amostra logarítmica + magnitude limitada.
Confiança de amostras pequenas reduz o peso de seleção; não é certeza científica.

O Analyst recebe o `raw_export` inteiro, fiel ao ZIP, além de um índice normalizado
com IDs curtos usado para validação e citações. Não existe priorização/truncamento
silencioso do dataset: se o pacote completo exceder `MAX_CONTEXT_CHARS`, o Analyst não
é chamado e a execução continua marcada (`context_too_large`) com a apresentação
estrutural local, dizendo exatamente quanto foi excedido. Duas saídas: aumentar
`MAX_CONTEXT_CHARS` ou definir `ANALYST_RAW_EXPORT=0` para enviar só o índice
normalizado, sem o ZIP bruto (~200 mil caracteres no export de referência). O JSON
bruto inclui inclusive `deleted/` e `orphaned/` para contexto histórico, mas o prompt
proíbe tratá-los como estado ativo da conta.

Dois ajustes deixam o veredito do Analyst mais estável sem afrouxar a evidência: notas
de 0–100 são lidas como porcentagem e viraram 0–1 (`score_normalization` registra cada
normalização em `semantic_findings.json`) e arrays acima do teto do schema são cortados
no limite documentado (`bounded_lists` registra quanto veio e quanto ficou). IDs, quotes,
números, vínculo de filmes, tags e listas continuam sendo checados um por um.

O validator verifica schema/tipos/faixas, IDs, vínculo dos filmes às fontes,
tags/listas citadas, trechos exatos e numeric_claims com caminhos de campos e valores
iguais aos dados. Números em algarismos no texto precisam de suporte explícito.
Findings list_meaning exigem membros reais das listas citadas; afirmações de sessões
exigem fontes diary/rewatch. Comparações explícitas com cronologia de lançamento são
rejeitadas, pois não existe fonte confiável de lançamento neste dataset.
Não prova semanticamente uma interpretação: causalidade, motivação ou uma afirmação
falsa com IDs verdadeiros ainda exigem revisão humana. Prompts proíbem essas inferências.
A checagem não entende todos os números por extenso nem todas as formas de paráfrase.

O Script Engine combina score × confiança com penalidades por tipo, filmes e tags
repetidos; descarta duplicatas por evidências, filmes e similaridade de texto.
Usa até dois momentos por categoria e pode reservar um finding semântico forte como
closer. Não preenche categorias vazias nem inventa callbacks. O que sai do seletor
são Editorial Moments display-first: cada um carrega o dado estruturado que o
frontend mostra sozinho (pós-ter com `film_key`, nota, trecho de review, sessões de
rewatch, tag com estatística, lista com membros, expressão recorrente com exemplos) e
só depois a fala. Momentos sem display suficiente são marcados e não valem uma cena.

O Final Writer recebe o roteiro INTEIRO de uma vez: o que o usuário já viu em cada
momento, a evidência de cada momento e os slots da abertura. Ele não pode adicionar,
remover, reordenar, renomear beat nem inventar filme, número ou contexto. Cada linha
é `{text, effect}`; `effect` é `none`, `strike` ou `correction`. O validator rejeita
JSON inválido, beat_id desconhecido ou ausente, excesso de linhas/palavras, quebras
internas, números fora da tela, Markdown cru, tokens de tempo e mais de 3 palavras em
um conceito do arquétipo. Uma linha que apenas repete o display do próprio momento é
descartada do texto e contada em `dropped_lines`, sem reprovar a execução. Não há
retry criativo automático nem fallback de piadas: silêncio é decisão válida.

## Prompts e módulos

`prompts/analyst.txt` tem tom editorial e devolve candidatos semânticos com evidência.
`prompts/writer.txt` é o Final Writer: ele vê o roteiro inteiro, preenche os slots da
abertura e as falas de cada `beat_id`, e é instruído a NÃO inventar coreografia — a
interface já pausa, mostra pôsteres e risca texto, então o texto deve ficar mais
simples, não mais teatral. Os dois vão como instruções de sistema separadas.
Versões `ANALYST_PROMPT_VERSION` (v1) e `WRITER_PROMPT_VERSION` (v2) ficam em
`src/ai_schemas.py` e aparecem nos outputs; a versão não altera comportamento.
`prompts/judge.txt` foi preservado como histórico e não é mais usado.

`app.py` cuida da CLI/Rich; `parser.py`, `models.py`, `analyzer.py`, `findings.py` e
`utils.py` mantêm a camada local. `context_builder.py` prepara o Analyst;
`validator.py` verifica candidatos semânticos; `finding_pool.py` normaliza origens;
`script_engine.py` seleciona momentos e monta o pedido do Writer; `editorial.py`
constrói o display de cada momento; `opening.py` monta a abertura por template;
`presentation.py` é o Presentation Builder e o contrato de eventos; `final_writer.py`
valida a resposta do Writer (ids, efeitos, números, tempo, arquétipo);
`resources.py` carrega locales e humor templates; `model_discovery.py` filtra e ordena
modelos; `generation.py` orquestra e audita; `gemini_client.py` separa
`analyze_semantically(...)`, `write_final(...)` e `list_models(...)`.

## Privacidade e testes

Dados pessoais de profile.csv são descartados, exceto referências a favoritos.
Emails em textos livres são removidos dos contextos. Isso não anonimiza toda review:
nomes pessoais e outros detalhes incidentais podem existir no texto original.
Não publique ZIP, `.env` ou `output/`; todos estão no `.gitignore`. Nenhuma chave
é hardcoded, e exceções brutas da SDK não são persistidas.

```powershell
python -m unittest discover -s tests -v
python -m pip check
python app.py --dry-run
python app.py --analyze-only
python app.py
```

Os testes usam dados sintéticos. Cobrem parser/listas/Unicode, médias, entidades de
rating, tags por sessão e amostra mínima, evidências e números inválidos, deduplicação,
diversidade/limite de momentos, orçamento, escopo do Writer, construitura da
abertura (typing/strike/correction/pausa/reveal), arquétipo de exatamente quatro
conceitos, eventos e enum de duração, marcação e tempo cru recusados, momento com
silêncio, Presentation Script válido sem resposta de IA, recursos de locale,
descoberta de modelos (filtro de `generateContent`, exclusão de TTS/imagem/live/
embedding/lyria/transcribe, ordem e dedup da corrente, limite da escada, cache curto),
duas chamadas no máximo, Writer incapaz de adicionar beats, cache validado, SDK com
mock e rastreabilidade dos pedidos.

### Validação desta versão

O export real preservou 106 vistos, 92 ratings, 110 sessões, 103 reviews e 2 listas.
O contexto do Analyst ficou em cerca de 200 mil caracteres, com todas as reviews. Os
findings grew para 65 com o novo tipo determinístico `own_list` (listas próprias com
composição medida), o que habilita momentos do tipo LIST.

Execução real (27/09/2026): descoberta dinâmica encontrou 19 modelos textuais
utilizáveis entre 61 listados e montou a corrente
`gemini-flash-latest → gemini-flash-lite-latest → gemini-2.5-flash → …`. O Analyst
veio do cache (1 candidato aceito, 3 rejeitados), o Script Engine selecionou 9
momentos (8 mids + 1 closer semântico) e o Final Writer respondeu em **uma** chamada
de ~31 mil caracteres, atendida por `gemini-flash-lite-latest` depois do 429 do modelo
principal. `presentation_script.json` saiu com 53 eventos cobrindo 12 tipos, validado
por `validate_presentation` e lido de ponta a ponta no terminal.

O `--dry-run` produz o mesmo roteiro sem nenhuma chamada: 8 momentos, 35 eventos,
`render.ai_generation: skipped` e `judgment.txt` com o cabeçalho de status. Nada de
frase fixa substitui reação de IA.

Limitações conhecidas: o filtro de modelos é heurístico porque `models.list` não
expõe capacidades para este projeto; quotes de review aparecem com 180 caracteres
(no frontend, o Recorte final fica a cargo do component de review); e o arquétipo só
existe quando há exatamente quatro favoritos resolvidos.

### Histórico: 26/09/2026, a execução que não teve julgamento

A execução arquivada em `output/runs/20260927T001615678505Z/` terminou em
`analysis_partial` porque a chamada do Analyst recebeu HTTP 429 (cota esgotada,
`limit_window: day`) na arquitetura antiga, que fazia uma chamada Writer por beat.
Foi essa falha que motivou a cadeia de fallback, a descoberta de modelos, a
apresentação estruturada e a troca por uma única chamada de Writer. A execução real
mais recente está descrita em "Validação desta versão".

## Pipeline web (Cloudflare Pages)

O backend web é independente do `app.py` e executa esta sequência dentro de Pages
Functions:

`ZIP → raw export sanitizado → perfil normalizado → análise determinística → relações
→ Analyst → materialização → Script Engine → Final Writer → presentation-v2`.

O Analyst recebe o inventário estruturado da conta, reviews completas, diário,
ratings, likes, listas, tags, estilo de escrita, cobertura de reviews, rewatches e
relações. O Final Writer recebe apenas os momentos já materializados e ordenados,
o fingerprint de estilo e callbacks possíveis. As duas etapas usam uma chamada por
etapa, com deadline e fallback de modelo.

#### Contrato do Analyst

O Analyst declara o contrato em `responseSchema` (`ANALYST_SCHEMA`), não em prosa: os
três arrays (`selected`, `interaction_candidates`, `top_four_semantics`) são exigidos
pela API e pelo gate. Antes, `top_four_semantics` era exigido no aceite sem nunca ter
sido enviado como schema — o modelo devolvia uma seleção perfeita, omitia um array e a
sessão inteira morria.

- `buildAnalystContext()` (`functions/_lib/analyst-context.js`) monta a ÚNICA
  representação enviada: filmes, ratings, diary, reviews integrais, listas, tags,
  likes, watchlist, comments, review_style, review_coverage, relações, afinidade,
  medições candidatas e Top 4. Tabelas que o perfil normalizado já carrega aparecem
  apenas no inventário (`export_inventory`); as que não têm equivalente
  (`watchlist`, `comments`, `likes/*`) mantêm as linhas; datas de logging/rating viram
  `library_log`. Nada é truncado em silêncio: as reviews mantêm o texto inteiro e
  `segments` (que repetia palavra por palavra) virou `markup`.
- Subcontratos separados: `editorialSelectionValid` e `topFourSemanticsValid`. Uma
  seleção válida nunca é descartada porque o Top 4 veio incompleto.
- Repair direcionado: `repair_semantics` (pede só os `film_key` ausentes, sem reenviar
  a conta), `repair_findings` ("adicione outros achados só se forem genuinamente
  fortes") e `repair_full` (rejeição completa, com o parcial preservado).
- `salvageJson` vive em `functions/_lib/json-repair.js` e é a MESMA implementação
  usada pelo Writer: `MAX_TOKENS` vira `truncated_output` e o que chegou antes do corte
  é preservado e reparado, em vez de virar `invalid_response`.
- Status: `complete` (seleção forte + Top 4), `thin` (poucos achados, mas válidos) e
  `failed` (nenhum conteúdo utilizável). `top_four_semantics_status` é registrado à
  parte (`complete`/`failed`/`not_required`), então um Top 4 ausente não derruba a
  sessão: ela continua com `thin`/`complete` e a informação fica auditável.

#### Cadeia de modelos, deadline e quota

- `mergeModels(configured,discovered)`: o primário configurado sempre primeiro; em seguida a
  escada de qualidade — Flash completos (geração mais nova primeiro), outros modelos textuais,
  previews e Flash-Lite por último, mesmo quando configurado explicitamente. Deduplicado, e a
  configuração explícita é apenas critério de desempate dentro do nível.
- A cadeia NÃO tem corte por quantidade: `MODEL_SAFETY_CEILING=24` existe só para impedir loop
  infinito e o **deadline de 75s** decide quantos modelos rodam. A descoberta lista até 20
  (`DISCOVERY_LIMIT`), então um modelo descoberto na última posição ainda é tentado se houver
  tempo — um 404 ou 429 que responde em menos de 1s nunca bloqueia os seguintes.
- 404/429: uma tentativa por modelo, sem repetição, avanço imediato. 503 (e demais 5xx):
  no máximo uma retry curta, se ainda houver orçamento; depois avanço. Timeout: avanço
  respeitando o deadline.
- Um 404/429 marca o modelo como indisponível **para aquela execução** (`env` compartilhado
  entre Analyst e Writer), então o Writer não paga de novo por um modelo que o Analyst já viu
  morto. Não persiste entre requisições.
- O timeout de cada requisição respeita o teto (20s) e reserva uma fatia mínima (8s) para cada
  modelo restante, dentro do deadline de 75s.
- Resposta não-2xx **nunca** é interpretada como saída do modelo: o registro tem
  `http`, `provider_error` (código/status/mensagem do provedor), `detail`, `timeout_ms` e
  `duration_ms`. `parse_error`/`finishReason` só existem quando houve geração 2xx.
- `thinkingConfig.thinkingBudget=0` é enviado por padrão (o thinking consumia o orçamento de
  saída em modelos 2.5) e é removido automaticamente se a API rejeitar com 400.
- Falha por cota ou rate limit é classificada como `quota_exceeded`/`rate_limited`, e o
  frontend mostra a mensagem de espera em vez de culpar a leitura do perfil.

Variáveis específicas podem separar os modelos:

- `GEMINI_ANALYST_MODEL` e `GEMINI_ANALYST_FALLBACK_MODELS`;
- `GEMINI_WRITER_MODEL` e `GEMINI_WRITER_FALLBACK_MODELS`;
- `GEMINI_MODEL` e `GEMINI_FALLBACK_MODELS` continuam compatíveis;
- `GEMINI_MODEL_DISCOVERY=0` desativa a descoberta server-side;
- `JUDGE_DEBUG_CONFIG=1` habilita `GET /api/config` (diagnóstico local: chave presente,
  descoberta ligada, cadeias montadas, modelos configurados fora do catálogo). Sem essa
  variável a rota responde 404 e nada de configuração é exposto; a chave nunca é
  devolvida em nenhum caso.

Deixar `GEMINI_FALLBACK_MODELS` vazio é o padrão recomendado: a descoberta monta a
cadeia a partir de `models.list`, e um nome fixo envelhece (404 remove o modelo da
etapa, mas o usuário perdeu uma reserva).

A geração possui três resultados:

- `complete`: seleção forte (ou `thin`) aceita pelo Analyst, abertura, roteiro, closer
  e Profile Review utilizáveis;
- `partial`: abertura coerente e pelo menos 70% dos momentos com reação;
- `failed`: a API devolve `writer_unavailable` (`stage: writer`); o chat não começa e a
  análise local só aparece quando o visitante escolhe essa ação. Falha na leitura do
  perfil devolve `analyst_unavailable` (`stage: analyst`) com outra mensagem: o Judge
  não terminou de ler o perfil, em vez de "leu tudo e perdeu a fala".

`presentation-v2` acrescenta `generation_meta`, `profile_review`, jogos contextuais e
`explainability`. O frontend ainda aceita `presentation-v1`. Ao final da sessão,
dois cards são compostos em Canvas — Post 1080×1350 ou Story 1080×1920 — para
arquétipo com Top 4 e Profile Review. Os cards não usam foto, avatar ou iniciais.
Pôsteres passam por `/api/image-proxy`,
restrito a `image.tmdb.org`, para manter o Canvas exportável. Quando arquivos são
aceitos pela Web Share API eles são compartilhados diretamente; nos demais
navegadores o fallback baixa PNG.

### Medições determinísticas do pipeline web

A etapa determinística nunca escreve piada: ela produz um POOL de candidatos (até
48) que o Analyst lê. O Script Engine aplica qualidade mínima e usa máximos de 8,
10 ou 12 beats conforme a riqueza da conta. O máximo nunca é uma quota: sete bons
achados continuam sendo sete.

O Analyst pode propor até quatro desafios e o Script Engine seleciona no máximo
dois, de tipos diferentes. `forced_triage` e `blind_rank` funcionam sem TMDb.
`defend_your_take` é removido silenciosamente quando o TMDb falha ou quando sua
amostra tem menos de 100 votos. Qualquer média externa é identificada como
"média do público no TMDb", nunca como média do Letterboxd.

- `letterboxd.js`: perfil normalizado, inventário do ZIP (`files_in_zip`,
  `files_processed`, arquivos conhecidos e desconhecidos), filmes, ratings, diary,
  reviews, listas, likes e comments.
- `review-style.js`: n-gramas úteis, aberturas, finais, markup, pontuação e
  comprimentos medidos. Nenhuma expressão é procurada por nome: "dito isso"
  aparece quando a conta realmente repete algo assim.
- `relationships.js`: tag×tag, tag×lista, lista×lista, tag×rating, lista×rating,
  tag×rewatch, lista×rewatch, estilo×rating, estilo×tag, favoritos e
  watchlist×visto.
- `temporal.js`: período mais movimentado, diferença observada entre as duas
  metades do diário (notas de sessão e comprimento das reviews) e movimentos de
  nota em reassistidas. Sequência não é causa: nada aqui afirma que algo mudou
  por algum motivo.
- `editorial.js`: materialização por ID, Script Engine com diversidade de famílias
  e callbacks (filme reaparecendo em outro momento).
- Pares de contraste só existem dentro de um contexto compartilhado (mesma tag ou
  mesma lista), nunca como menor nota versus maior nota.
- O spotlight de review é um leque (duas mais curtas, mais longa, menor nota,
  maior nota, com tag) sem repetir a mesma review em dois candidatos.

`deleted/` e `orphaned/` nunca entram no estado ativo. `profile.csv` é sanitizado
(username, display name e favoritos) antes de chegar ao Analyst.

### Observabilidade

Em `wrangler pages dev` o console da Function mostra o caminho inteiro: arquivos
lidos, reviews/tags/listas/relações, tamanho do contexto e das seções do Analyst,
cadeia numerada de modelos, cada tentativa (modelo, fase, status HTTP, `finishReason`,
tamanho da resposta, `json` valid/salvaged/unreadable, `timeout_ms`, `duration_ms`),
repairs disparados, achados preservados, Top 4 por `film_key`, `Writer called: true`,
modelo servido, reações por beat, archetype/closer/Profile Review e o estado final da
apresentação. Nem a chave da API nem o prompt aparecem em log ou resposta.

Fora da nuvem, dois harnesses repetem a execução real com o export do workspace:

```bash
node scripts/analyst-diagnostic.mjs caminho-do-export.zip
node scripts/test-web-pipeline.mjs caminho-do-export.zip
node scripts/test-web-pipeline.mjs caminho-do-export.zip --stub
```

O primeiro mostra a conversa HTTP completa do Analyst e o motivo concreto de cada
rejeição. O segundo roda o pipeline inteiro; `--stub` responde o lado do modelo
localmente (marcado no log) para quando a conta está sem cota, mantendo export,
contexto, Script Engine, contrato do Writer e apresentação reais.

### Testes

`npm run test:web` cobre parser, análise determinística, relações, Script Engine,
contrato da apresentação, `ai_unavailable`, estado parcial, Profile Review,
explainability e o fingerprint enviado ao Writer. `web-tests/analyst.test.js` cobre o
contrato do Analyst: Top 4 ausente/parcial com repair direcionado, seleção preservada
quando o repair de semantics falha, JSON truncado vira `truncated_output`, o request
carrega `responseMimeType`/`responseSchema`/`maxOutputTokens`, `thin` não é falha, falha
real devolve `analyst.status = failed` sem promover candidatos determinísticos, a
deduplicação do contexto e as mensagens distintas de Analyst/Writer no frontend. A
cadeia de modelos tem regressões próprias: modelo 7 e 8 descobertos são alcançados
quando os anteriores falham rápido, 404 avança sem repetir, 429 não repete o mesmo
modelo, 5xx tem uma única retry curta, Lite fica depois de todos os Flash completos,
modelo configurado duplicado não aparece duas vezes, `gemini-2.5-flash` não entra sem
configuração ou descoberta, resposta não-2xx nunca gera `parse_error`, o deadline
interrompe o laço e todos falhando o Analyst vira FAILED sem chamar o Writer.
`npm run test:browser` cobre layouts, demo, harness, os dois cartões compartilháveis
(PNG 1080×1350, download como fallback), o card da Profile Review, "Entenda como este
output foi gerado" e o fluxo `AI_FAILED` com a análise local como escolha.
## Modos de pipeline

`judge-mode.json` na raiz é a única fonte de verdade do modo ativo:

- `"curated"`: pipeline existente — análise determinística, Analyst, Script Engine e Writer.
- `"freeform"`: ZIP completo → JSON lossless/AI → uma chamada editorial Freeform Judge → Presentation.

Depois de trocar o valor, execute `python scripts/sync-mode.py` antes de rodar ou fazer deploy.
`python scripts/sync-mode.py --check` falha quando o artefato Cloudflare está divergente; `npm run build`
faz a sincronização automaticamente. Não configure o modo no dashboard da Cloudflare.

O modo Freeform é experimental e envia ao Gemini todo o conteúdo textual e celular do export, incluindo
reviews, comments, likes, listas, arquivos em `deleted/` e `orphaned/` e arquivos desconhecidos. Binários
grandes permanecem no JSON lossless local, enquanto o modelo recebe seus metadados, tamanho e SHA-256.
Se o contexto não couber, a execução falha explicitamente com `freeform_context_too_large`; não há corte
silencioso nem fallback automático para Curated.
