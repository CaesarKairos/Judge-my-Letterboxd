# Judge My Letterboxd — Backend Prototype

Protótipo de terminal em Python. O ZIP oficial é interpretado localmente; o Gemini
recebe JSON. Sem frontend, Flask, banco de dados, scraping ou API externa de filmes.
O terminal usa Rich para painéis, tabelas, cores e indicador de leitura.

## Pipeline

```text
ZIP → parser → perfil unificado → analyzer → findings determinísticos
                                             ↓
                        contexto → AI Analyst (JSON)
                                             ↓
                              validação de evidências
                                             ↓
                           Finding Pool com origem preservada
                                             ↓
                         Script Engine determinístico (até 10 beats)
                                             ↓
                   AI Writer (uma chamada pequena por beat, JSON)
                                             ↓
                        validação → julgamento no terminal
```

Python mede. Analyst identifica relações semânticas e cita fontes. Script Engine
escolhe assunto, ordem e modo. Writer apenas reage às evidências do beat atual.
Não existe mais chamada que recebe a conta inteira e escreve o julgamento direto.

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
```

- Normal: análise local, Analyst, roteiro e uma chamada Writer por beat.
- `--dry-run`: nenhuma chamada à IA, mesmo com chave; monta roteiro determinístico.
- `--analyze-only`: chama Analyst, valida e mostra o roteiro; nunca chama Writer.
- `--no-analyst`: pula o Analyst e deixa o Writer julgar somente com findings
  determinísticos (útil quando a cota do modelo grande acabou); `semantic_findings.json`
  fica vazio e `run_status.json` registra `analyst: skipped_by_flag`.
- Sem chave: qualquer modo conclui a parte local e informa que pulou a IA.
- `--show-findings`: mostra todos os findings determinísticos. Pode combinar flags;
  `--dry-run` sempre prevalece sobre chamadas à IA.

Uma execução completa pode fazer até 13 chamadas lógicas (1 Analyst + 12 Writer),
com custo e tempo maiores que a antiga chamada única. Falhas transitórias HTTP
408/429/500/502/503/504 têm até três tentativas dentro da mesma chamada, com atraso
limitado; timeout de 120s por tentativa. HTTP 400 não recebe repetição automática.
Falha no Analyst preserva o roteiro local e pula Writer; falha em um beat preserva
os demais. Saída parcial fica explicitamente marcada e retorna código 1, nunca é
disfarçada de sucesso.

Quando o erro é 404/429/500/502/503/504, o modelo configurado é trocado pelos de
`GEMINI_FALLBACK_MODELS` antes de desistir, e o modelo que respondeu aparece em
`served_model`. Depois de HTTP 401/403/429 esgotar todos os modelos, os próximos
beats são pulados para não insistir com credencial inválida ou cota esgotada.

## Quando `judgment.txt` não traz um julgamento

`judgment.txt` começa com `[STATUS DO PROGRAMA — NÃO É UM JULGAMENTO DA IA]` quando
nenhuma linha do Writer passou na validação. Isso é intencional: o arquivo nunca
finge ser uma resposta do modelo. Nesse caso, os fatos ficam em `run_status.json`
(status das etapas, `analyst_error_code`, `reason`, `limit_window`, `attempted_models`),
em `writer_inputs.json` (cada resposta bruta, mesmo rejeitada) e em `script.json`
(roteiro determinístico completo). Execuções anteriores são copiadas para
`output/runs/<timestamp>/` antes de qualquer limpeza.

Motivos mais comuns e o que fazer:

| `run_status.json` | Causa | Ação |
| --- | --- | --- |
| `analyst: failed`, `error.code: 429`, `limit_window: day` | Cota diária (RPD) do modelo esgotada | RPD renova à meia-noite do Pacífico (04h em Brasília); ou usar `GEMINI_FALLBACK_MODELS` com outro modelo (a cota é por modelo e por projeto); ou rodar `--no-analyst` |
| `analyst: failed`, `error.code: 429`, `limit_window: minute` | Limite por minuto | Esperar e repetir; reduzir `SCRIPT_MAX_BEATS` |
| `analyst: failed`, `error.code: 401/403` | Credencial inválida | Conferir `GEMINI_API_KEY` no `.env` |
| `writer: partial`, `error_code: 429` em um beat | Cota acabou no meio | Beat preserva o erro; repetir a execução depois da renovação (respostas já validadas vêm do cache local) |
| `writer: partial`, `status: rejected` | Resposta fora das regras (linhas, palavras, números novos) | Ver `raw_response` e `errors` no beat; ajustar `WRITER_*` |

## Configuração

Variáveis de ambiente prevalecem sobre `.env`. Nenhuma chave é gravada nos outputs.

| Variável | Default | Uso |
| --- | --- | --- |
| `GEMINI_API_KEY` | vazio | Chave do Gemini |
| `GEMINI_MODEL` | `gemini-flash-latest` | Modelo configurável para ambas as etapas |
| `GEMINI_FALLBACK_MODELS` | vazio | Cadeia de reserva separada por vírgula, tentada em 404/429/5xx (a cota é por modelo); `served_model` diz quem respondeu |
| `JUDGE_LANGUAGE` | `pt-BR` | Idioma das observações e reações |
| `MAX_CONTEXT_CHARS` | `300000` | Prompt + dados do Analyst |
| `SCRIPT_MAX_BEATS` | `10` | Máximo entre 1 e 12; qualidade pode resultar em menos |
| `WRITER_MAX_CONTEXT_CHARS` | `16000` | Prompt + dados de cada chamada Writer |
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

Comece pelo beat em `judgment.json`, siga seus `finding_ids` para `script.json`
e `finding_pool.json`. Em `writer_inputs.json`, confira o pedido exato, as fontes,
a resposta bruta e o resultado da validação. Um texto gerado não recebe novas
evidências por ter sido escrito pelo Writer.

Cada execução com ZIP substitui somente os arquivos gerados conhecidos em `output/`:

| Arquivo | Conteúdo |
| --- | --- |
| `extracted_profile.json` | Extração consolidada, originais, URIs, datas, inventário e avisos |
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
| `script.json` | Ordem, categoria, finding, motivo/penalidades de seleção, modo e evidência de cada beat; excluídos com motivo |
| `writer_inputs.json` | Por beat: versão, evidência, contexto anterior, pedido exato, resposta bruta, parsed_lines (inclusive rejeitadas), accepted_lines, erros, status, `served_model`, `model_attempts` e `dropped_display_repeats` |
| `judgment.json` | Linhas exibidas pelo Python e linhas geradas, separadas por beat |
| `judgment.txt` | Texto final exibido, montado com quebras de linha e espaços entre beats |
| `run_status.json` | Estado real das etapas, modelo, cadeia de reserva, versões dos prompts, origem (api/cache) e tentativas por modelo |
| `debug_report.txt` | Inventário, avisos, cobertura e estado da execução |

`judgment.txt` não é mais a resposta de uma chamada única. As respostas brutas de
cada chamada Writer estão em `writer_inputs.json`, mesmo se rejeitadas. No modo
local/analyze-only, o julgamento fica vazio, o roteiro permanece inspecionável.
Uma preparação de pedido não significa envio: confira os status. Os artefatos do
Writer são persistidos após cada beat, para auditoria de execuções parciais.
Mesmo em dry-run/analyze-only, os pedidos Writer ficam preparados com status skipped,
para inspecionar o escopo sem consumir chamadas.

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

O Analyst recebe nomes/anos uma vez no catálogo, com IDs curtos usados em diary,
reviews e findings. Textos completos das reviews aparecem uma vez e permanecem
inteiros quando selecionados. O budget prioriza reviews e inclui identidades dos
filmes referenciados; coverage registra registros omitidos. Somente fontes presentes
no contexto efetivamente enviado podem ser citadas pelo Analyst.

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
Usa até dois beats por categoria, inclui abertura factual e pode reservar um finding
semântico forte como closer. Não preenche categorias vazias nem inventa callbacks.
Modes disponíveis: raw_reveal, short_reaction, contrast, quote_reaction,
semantic_punch, callback e closer. Callback fica reservado para vínculo explícito;
o seletor atual nunca o cria por inferência.

Writer recebe só o beat: evidências, identidade mínima dos filmes, modo, idioma,
display e previous_context vazio (salvo futuro callback explícito). Reviews citadas
chegam como excertos verificados, não como a coleção inteira. O validator rejeita
JSON inválido, excesso de linhas/palavras, quebras internas, números novos e linhas
idênticas já emitidas. Uma linha que apenas repete o display do próprio beat é
descartada do texto e registrada em `dropped_display_repeats` do beat, sem reprovar
a execução. Não há retry criativo automático nem fallback de piadas.
Silêncio é permitido quando o Python já exibe um dado ou citação.

## Prompts e módulos

`prompts/analyst.txt` tem tom editorial; `prompts/writer.txt` contém a persona e as
regras de reações curtas em português brasileiro. São enviados como instruções de
sistema separadas. Versões `ANALYST_PROMPT_VERSION` e `WRITER_PROMPT_VERSION` estão
em `src/ai_schemas.py` e aparecem nos outputs. A versão não altera comportamento.
`prompts/judge.txt` foi preservado como histórico e não é mais usado na geração.

`app.py` cuida da CLI/Rich; `parser.py`, `models.py`, `analyzer.py`, `findings.py` e
`utils.py` mantêm a camada local. `context_builder.py` prepara o Analyst;
`validator.py` verifica contratos; `finding_pool.py` normaliza origens;
`script_engine.py` seleciona; `generation.py` orquestra e audita; `gemini_client.py`
separa `analyze_semantically(...)` e `write_beat(...)`.

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
diversidade/limite de beats, categorias ausentes, orçamento, escopo do Writer,
modos sem IA/sem Writer, `--no-analyst`, cadeia de modelos de reserva (troca em 404/429,
parada em 400, erro final com tentativas registradas), SDK com mock e rastreabilidade
dos pedidos.

### Validação desta refatoração

O export real preservou 106 vistos, 92 ratings, 110 sessões, 103 reviews e 2 listas.
O dry-run final produziu 63 findings e 8 beats. O contexto Analyst ficou em cerca
de 199 mil caracteres, com todas as reviews, contra aproximadamente 261 mil antes.
As chamadas Writer observadas ficaram entre 6,1 mil e 9,3 mil caracteres.

O Analyst real retornou 11 candidatos. A validação final aceita 7: rejeita referências
inválidas, associação incorreta de membro de lista e afirmação de sessões sem diary.
O Writer real gerou reações curtas; um número sem suporte foi rejeitado. A execução
completa ficou parcial por erros do serviço e HTTP 429 de cota do plano gratuito
(limite informado: 20 requisições). Não houve nova chamada após confirmar a cota.
Portanto, a qualidade de um roteiro completo com as últimas correções ainda requer
nova execução quando a cota permitir. Não há promessa de humor ou semântica perfeitos.

Os outputs da última chamada real foram preservados localmente em
`output/validation_runs/live_before_final_validation/`, com
`final_revalidation.json` mostrando as rejeições adicionais das checagens finais.
Esse arquivo é uma revalidação offline, não uma nova resposta da IA. O `output/`
principal contém o dry-run final, sem julgamento gerado.

### Execução de 26/09/2026: por que não houve julgamento

A execução registrada em `output/runs/20260927T001615678505Z/` terminou em
`analysis_partial` porque a única chamada do Analyst recebeu HTTP 429 do Gemini —
cota esgotada, com `limit_window: day`. Não foi bug de escrita: o Writer nunca foi
chamado, por regra, e por isso `judgment.txt` recebeu apenas a explicação. Nada foi
perdido: o roteiro de 8 beats ficou em `script.json` e os 63 findings locais seguem
em `findings.json`.

A cota por dia (RPD) é contada por modelo e por projeto e renova à meia-noite do
Pacífico (04h em Brasília). Para não depender de um único modelo, esta versão passou
a tentar `GEMINI_FALLBACK_MODELS` em 404/429/5xx, a repetir 429 dentro da mesma
chamada (o SDK já repetia, mas o código excluía 429 da lista) e a oferecer
`--no-analyst`, que julga apenas com findings determinísticos. A explicação em
`judgment.txt` agora termina com a dica correspondente.

Sondagem real desta chave em 26/09/2026: `gemini-flash-latest` devolveu 429,
`gemini-flash-lite-latest` respondeu e `gemini-2.5-flash-lite` devolveu 404 (nome
indisponível). Por isso o `.env.example` traz apenas `gemini-flash-lite-latest`:
um nome inválido não quebra a execução, mas polui a cadeia com um erro alheio.

Com a cadeia configurada, a mesma conta gerou julgamento completo (`status: complete`,
`judgment_generated: true`): Analyst aceitou 2 candidatos e rejeitou 2, o roteiro
ficou com 9 beats e os 9 beats foram validados pelo modelo de reserva. A execução
seguinte reaproveitou o cache local, sem novas chamadas, e o texto final saiu sem a
linha que repetia o display do primeiro beat.
