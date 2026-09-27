# Judge My Letterboxd — Backend Prototype

Protótipo de terminal em Python. O ZIP oficial é interpretado localmente; o Gemini
recebe JSON. Sem frontend, Flask, banco de dados, scraping ou API externa de filmes.
O terminal usa Rich para painéis, tabelas, cores e indicador de leitura.

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

Python mede e seleciona. O Analyst identifica relações semânticas e cita fontes. O
Script Engine escolhe assunto, ordem e modo. O Writer reage ao roteiro inteiro sem
poder mudá-lo. O Presentation Builder traduz tudo em eventos: é o contrato do
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
- `--no-analyst`: pula o Analyst; o roteiro usa apenas findings determinísticos.
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
| `GEMINI_MODEL` | `gemini-flash-latest` | Modelo configurável para ambas as etapas |
| `GEMINI_FALLBACK_MODELS` | vazio | Cadeia de reserva separada por vírgula, tentada em 404/429/5xx (a cota é por modelo); `served_model` diz quem respondeu |
| `JUDGE_LANGUAGE` | `pt-BR` | Idioma das observações e reações |
| `MAX_CONTEXT_CHARS` | `1000000` | Prompt + dados do Analyst |
| `SCRIPT_MAX_BEATS` | `8` | Máximo entre 1 e 12; qualidade pode resultar em menos |
| `WRITER_MAX_CONTEXT_CHARS` | `60000` | Prompt + o roteiro inteiro em UMA chamada Writer |
| `WRITER_MAX_LINES` | `3` | Teto global; cada momento define seu próprio `max_lines` (2) |
| `WRITER_MAX_WORDS_PER_LINE` | `24` | Teto rígido; preferência de estilo: 2–12 |
| `ANALYST_TEMPERATURE` | `0.2` | Temperatura independente |
| `WRITER_TEMPERATURE` | `0.7` | Temperatura independente |
| `MODEL_DISCOVERY` | `1` | Descoberta dinâmica via `models.list` antes do Writer |
| `MODEL_DISCOVERY_CHAIN_LIMIT` | `5` | Quantos modelos descobertos entram na corrente |
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
- `top_four_archetype` exige exatamente quatro conceitos, de uma ou duas palavras,
  distintos, sobre TEMA/atmosfera/cenário/elemento narrativo dos quatro favoritos —
  nunca um diagnóstico da pessoa. Menos de quatro (ou conceito fora das regras) →
  o bloco do arquétipo é omitido e a abertura segue sem ele.
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

## Regras de análise e validação

Filmes usam título NFC/casefold/espaços normalizados + ano. URIs são preservadas,
mas não fazem os joins. Homônimos no mesmo ano podem colidir; grafias diferentes
não são resolvidas por inferência. Favoritos usam correspondência local exata de
URI, ignorando barra final; os não identificados ficam sem rating inventado.
Arquivos opcionais ausentes são aceitos; desconhecidos são inventariados.
`deleted/` e `orphaned/` nunca entram no perfil ativo. CSV de listas detecta o
header de filmes após o bloco de metadados. Limites de ZIP: 50 MB por CSV conhecido,
200 MB de tamanho descompactado declarado. Espera-se o layout oficial na raiz.

Rating atual vem de `ratings.csv`. Rating de sessão vem só daquela linha de diary;
rating de review vem daquela review. Null nunca é preenchido com outro rating.
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
com IDs curtos usado para validação e citações. Não existe mais priorização/truncamento
silencioso do dataset: se o pacote completo exceder `MAX_CONTEXT_CHARS`, a execução
falha de forma explícita e pede aumento do limite. O JSON bruto inclui inclusive
`deleted/` e `orphaned/` para contexto histórico, mas o prompt proíbe tratá-los como
estado ativo da conta.

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
