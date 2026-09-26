# Judge My Letterboxd — Backend Prototype

Primeiro protótipo em Python, executado somente no terminal. O backend lê o ZIP
oficial localmente, consolida filmes, calcula estatísticas e organiza evidências.
O Gemini interpreta essas evidências e escreve o julgamento. Não há site, frontend,
Flask, banco de dados, scraping ou API externa de filmes.

## Instalação e execução

Requer Python 3.11 ou superior. No PowerShell, dentro desta pasta:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
Copy-Item .env.example .env
```

Edite `.env` e preencha `GEMINI_API_KEY`. Nunca compartilhe esse arquivo.
As demais opções são `GEMINI_MODEL=gemini-flash-latest`, `JUDGE_LANGUAGE=pt-BR`
e `MAX_CONTEXT_CHARS=300000`. Variáveis já definidas no ambiente têm precedência.
O modelo é configurável; sua disponibilidade depende da conta e do serviço.

Coloque o ZIP exportado oficialmente ao lado de `app.py` e rode a partir dessa pasta:

```powershell
python app.py
python app.py --dry-run
python app.py --show-findings
```

Se a ativação do ambiente estiver bloqueada, use diretamente
`.\.venv\Scripts\python.exe app.py --dry-run` (o mesmo prefixo serve para os outros comandos).
Em Linux/macOS, ative com `source .venv/bin/activate`.

Um ZIP na pasta atual é selecionado automaticamente; vários abrem uma seleção
numerada. Sem ZIP, o programa explica o problema e encerra. `--dry-run` nunca chama
a IA. Sem chave, a execução normal também conclui toda a análise local.
A chamada com chave usa a SDK moderna [google-genai](https://github.com/googleapis/python-genai),
com `from google import genai`. `python-dotenv` carrega o `.env`; são as únicas
dependências diretas. Parser e análise usam a biblioteca padrão e funcionam offline.

## Auditoria

Cada execução com ZIP substitui os arquivos conhecidos em `output/`:

| Arquivo | Conteúdo |
| --- | --- |
| `extracted_profile.json` | Perfil consolidado, textos originais, URIs, datas, fontes, inventário e avisos. Campos pessoais de profile.csv são descartados. |
| `profile_summary.json` | Todas as medições, grupos de ratings, histórico de sessões, tags, interseções, listas e comprimentos de reviews. |
| `findings.json` | Candidatos ordenados, score, evidências, filmes e fontes. |
| `ai_context.json` | Texto JSON exato usado como mensagem de dados. |
| `ai_request.json` | Argumentos exatos da chamada: modelo, mensagem, system instruction e temperatura; sem chave. |
| `ai_response.json` | Resposta completa serializada da SDK, quando houver resposta. |
| `judgment.txt` | Texto retornado, preservando quebras de linha. Fica vazio quando a IA é pulada. |
| `run_status.json` | Estado da execução, inclusive chamada pulada ou falha no Gemini. |
| `debug_report.txt` | Inventário, avisos e cobertura do contexto. |

`ai_request.json` é um pedido preparado; `run_status.json` indica se foi enviado.
Erros do serviço preservam os resultados locais. Mensagens brutas de exceções da SDK
não são gravadas, para evitar exposição de credenciais. O ZIP nunca é enviado.
ZIPs, `.env`, `output/` e o ambiente virtual estão no `.gitignore`.
Os arquivos locais contêm textos pessoais escritos pelo usuário: não os publique.

## Arquitetura

- `app.py`: descoberta do ZIP, CLI, arquivos de auditoria e orquestração.
- `src/parser.py`: CSVs UTF-8/BOM em memória, metadados de listas e perfil unificado.
- `src/models.py`: dataclasses de filmes, sessões, reviews, listas, perfil e findings.
- `src/analyzer.py`: estatísticas, histórico, comprimentos, padrões de escrita e tags.
- `src/findings.py`: candidatos descritivos com ordenação transparente.
- `src/context_builder.py`: seleção de evidências e orçamento de caracteres.
- `src/gemini_client.py`: chamada isolada à SDK, com timeout de 120 segundos.
- `src/utils.py`: normalização Unicode, parsing e operações compartilhadas.
- `prompts/judge.txt`: personagem e regras da IA, editáveis sem mudar Python.
- `tests/`: dados exclusivamente sintéticos, sem textos do export real.

## Definições e limites do MVP

Filmes são unidos por título em Unicode NFC, casefold, espaços normalizados e ano.
Todas as URIs são preservadas, mas não determinam os joins. Títulos iguais no mesmo
ano podem colidir; grafias diferentes e anos ausentes não são resolvidos por inferência.
O parser espera os nomes e colunas do export oficial em inglês na raiz do ZIP.
Arquivos opcionais ausentes são aceitos; desconhecidos são inventariados sem leitura.
`deleted/` e `orphaned/` nunca entram no perfil ativo. Limites preventivos: 50 MB por
CSV conhecido e 200 MB de tamanho descompactado declarado por ZIP.

Rating atual vem apenas de `ratings.csv`; notas históricas vêm das sessões/reviews.
Filmes vistos são os presentes em `watched.csv`. Sessões são apenas as linhas de
`diary.csv`: uma review não cria outra sessão. Rewatches explícitos e repetições
observadas são medidas separadas e não devem ser somadas. Datas ausentes ou sessões
no mesmo dia não estabelecem direção temporal confiável. A exportação pode não
conter todo o histórico; não inferimos sessões anteriores ao diário.

Favoritos são relacionados por correspondência exata com URIs conhecidas, removendo
apenas a barra final. Sem correspondência única, ficam não resolvidos, sem rating
inventado; não seguimos redirects nem acessamos a internet para identificá-los.
Likes de filmes, reviews e listas são contabilizados separadamente. Ausência de like
não expressa opinião negativa.

Tags não recebem interpretação semântica. Frequência de registros soma ocorrências
em diary e reviews e pode contar a mesma sessão duas vezes; filmes únicos, sessões
e reviews também são informados separadamente. Médias por tag usam ratings atuais
de filmes únicos; médias de sessões são informadas à parte. Interseções exigem
ao menos 3 filmes em cada tag e 3 em comum, Jaccard >= 0.3 ou inclusão >= 80%; somente
os 50 melhores pares são mantidos.

Reviews conservam o texto original, inclusive eventual HTML. A contagem de palavras
e n-grams ignora marcação HTML; caracteres brutos e de texto sem HTML são registrados.
Reviews curtas têm até 5 palavras; longas têm ao menos 500 caracteres e atingem o
percentil 90. Percentis usam interpolação linear. A correlação de Pearson e as médias
de comprimento por nota são descritivas, sem alegação causal. Padrões usam n-grams de
3 a 5 palavras e aberturas de 4, em pelo menos `max(3, round(3% das reviews))` reviews
distintas, com filtro pequeno de palavras funcionais e limite de 30 padrões.
São candidatos; não representam compreensão linguística completa.

O score é `round((15 + min(30, 6*log2(amostra)) + 55*magnitude) * confiança)`, limitado
a 0–100. Magnitude é uma heurística normalizada conforme o tipo: proporção,
diferença de rating, sobreposição ou prioridade fixa da categoria. `confidence=1`
indica contagem direta dos registros, não certeza estatística sobre a pessoa.
O backend não escreve piadas nem decide se dois filmes merecem comparação semântica.

O orçamento inclui os caracteres do prompt e da mensagem JSON (não tokens nem o
envelope serializado da SDK). Se tudo couber, inclui todas as reviews e coleções.
Caso contrário, reserva inicialmente metade do espaço restante para reviews
priorizadas por findings, ratings extremos, favoritos, listas e tags. Depois inclui
findings, rewatches, favoritos, listas, tags e catálogo, completando com reviews e
comentários. Reviews são incluídas inteiras ou omitidas, nunca cortadas. `coverage`
explicita contagens incluídas e omitidas por coleção. Limites muito pequenos geram
mensagem clara. O empacotamento é guloso, não uma otimização de tokens.

Dados pessoais de `profile.csv`, exceto referências a filmes favoritos, não são
retidos. Emails em textos livres são substituídos no contexto por `[email removido]`;
os originais permanecem apenas no debug local. Isso não é anonimização geral de
reviews: nomes e informações pessoais escritos incidentalmente podem estar nelas.
O prompt instrui a IA a tratar o export como dados, ignorar instruções nele e não
inventar estatísticas ou popularidade pública. Ainda é necessário avaliar criticamente
o texto gerado: instruções não garantem ausência absoluta de alucinações.

## Validação

```powershell
python -m unittest discover -s tests -v
python -m pip check
python app.py --dry-run
```

Testes cobrem CSV multilinha/BOM, listas com cabeçalho especial, Unicode, joins,
ratings, tags, médias, rewatches, mudanças de nota, interseções, comprimentos,
HTML, score, arquivos ausentes, favoritos não resolvidos, privacidade, orçamento,
descoberta de ZIP, execução sem chave, pedido exato e preservação da resposta.
A chamada SDK é validada com mock, sem custos ou rede.

O smoke test local no export disponível encontrou 106 filmes vistos, 92 ratings,
110 sessões, 103 reviews, 236 itens na watchlist, 9 rewatches explícitos, 7 tags,
2 listas, 0 filmes curtidos, 62 reviews curtidas e 17 listas curtidas. Os quatro
favoritos foram relacionados localmente. Todas as reviews cabem no limite padrão.
Esses números documentam a validação, não são fixtures nem regras do sistema.
Sem API key, o teste real da qualidade textual do Gemini permanece pendente.
