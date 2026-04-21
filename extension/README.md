# Sinucada Aim Helper — Extensão Chrome

Auxiliar de mira geométrico (ghost ball) para **estudo pessoal** de física e
geometria aplicada à sinuca em partidas de **treino/replay** no site
`sinucada.com`.

> ⚠️ **Aviso importante:** esta extensão é uma ferramenta educacional. Usá-la
> em partidas valendo prêmio contra outros jogadores reais pode violar os
> Termos de Serviço da Sinucada e é considerado trapaça. Use por sua conta e
> risco, preferencialmente em modo espectador (`/watch/...`), replay ou mesas
> de treino.

## Como instalar (modo desenvolvedor)

1. Baixe/clone a pasta `extension/` inteira para seu computador.
2. Abra o Chrome e vá em `chrome://extensions/`.
3. Ative **"Modo do desenvolvedor"** (canto superior direito).
4. Clique em **"Carregar sem compactação"** e selecione a pasta `extension/`.
5. A extensão aparecerá na barra de ferramentas (ícone verde "S").

## Como usar

1. Entre em uma partida (ou replay) em `https://sinucada.com/...`.
2. Clique no ícone da extensão e ative o toggle **"Ativar mira"**.
3. Um painel flutuante aparece no canto direito. Passos:

   **1. Calibrar** — clique em **Calibrar** no painel e então clique,
   **nesta ordem**, nos 4 cantos da mesa:
   1. Canto superior esquerdo
   2. Canto superior direito
   3. Canto inferior direito
   4. Canto inferior esquerdo

   As 6 caçapas (4 cantos + 2 laterais do meio) são derivadas automaticamente.

   **2. (Opcional) Detectar bolas** — clique em **Detectar bolas** para rodar
   a detecção automática via análise de pixels. Marcadores brancos aparecem
   em cada bola identificada; a bola branca é destacada.

   **3. Escolher branca** — clique e depois clique sobre a bola branca.
   Se a detecção encontrou bolas próximas, o clique é "imantado" ao centro da
   bola detectada mais próxima.

   **4. Escolher alvo** — idem, mas clicando na bola que você quer encaçapar.

   **5. Escolher caçapa** — clique próximo à caçapa desejada. O clique é
   imantado para a caçapa mais próxima das 6 calibradas.

   Pronto! A mira aparece com:
   - **Linha verde tracejada**: direção em que a bola branca deve ser jogada.
   - **Círculo branco (ghost ball)**: posição que a bola branca deve ocupar
     no momento do contato.
   - **Linha amarela tracejada**: trajetória que a bola alvo fará até a caçapa.

   Use o slider **Raio** para ajustar o tamanho do círculo fantasma ao
   tamanho real das bolas do jogo.

## Controles do painel

- **Calibrar** — reinicia calibração dos 4 cantos.
- **Detectar bolas** — detecção automática por cor/forma.
- **Escolher branca / alvo / caçapa** — entra em modo de seleção.
- **Limpar seleção** — apaga bola branca/alvo/caçapa (mantém calibração).
- **Resetar tudo** — limpa calibração + seleção.

## Observações técnicas

- A extensão força `preserveDrawingBuffer: true` no contexto WebGL do canvas
  do jogo para permitir a leitura de pixels (detecção automática). Isso
  pode ter pequeno impacto de performance.
- A detecção de bolas é simples (color-blob) — pode falhar em mesas escuras,
  com sombras ou cores similares ao feltro. Nestes casos use a seleção
  manual, que sempre funciona.
- A calibração é salva por aba/navegador. Se a mesa for reposicionada (novo
  jogo, redimensionamento), clique em **Resetar tudo** e recalibre.
- A matemática usada é a clássica do ghost ball (cue → ghost → bola alvo
  → caçapa), sem considerar efeito ("english"), elasticidade ou colisões
  intermediárias. É uma aproximação para mirada reta.

## Arquivos

```
extension/
├── manifest.json     # Manifest V3
├── background.js     # Service worker (bridge)
├── content.js        # Overlay + lógica de mira
├── inject.js         # Patch em getContext (MAIN world)
├── popup.html        # UI do toggle
├── popup.js
├── overlay.css       # Estilos do painel
├── icons/            # 16 / 48 / 128 px
└── README.md
```
