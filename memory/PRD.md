# Sinucada Aim Helper — PRD

## Problema original
Criar uma extensão Chrome que sirva como auxiliar de mira (aim) para jogo de
sinuca online no site sinucada.com. Quando ativada, a extensão deve mostrar
uma mira indicando onde o jogador deve bater para encaçapar a bola.

## Escolhas do usuário (confirmadas)
- Propósito: estudo pessoal / aprendizado de geometria e física
- Tipo de mira: linha geométrica simples (ghost ball)
- Detecção: automática de bolas e caçapas (com fallback manual)
- Fonte de dados: apenas o que é renderizado no canvas

## Personas
- Jogador amador/estudante de sinuca usando modo espectador ou treino para
  visualizar o ponto exato de contato (ghost ball) e treinar a mente para
  identificar jogadas corretas.

## Requisitos centrais
1. Extensão Chrome Manifest V3 carregável em modo desenvolvedor.
2. Ativável via popup toggle.
3. Overlay transparente sobrepondo o canvas do jogo (sincronizado em resize/scroll).
4. Calibração de mesa por 4 cliques (cantos), pockets derivadas.
5. Seleção manual de bola branca, bola alvo e caçapa (imã nas bolas detectadas).
6. Detecção automática opcional via análise de pixels (color-blob).
7. Desenho de ghost ball, linha de mira e trajetória bola-caçapa.
8. Ajuste de raio da bola via slider.
9. Persistência de calibração via `chrome.storage.local`.

## Arquitetura
- `manifest.json` — MV3, content scripts + background service worker.
- `inject.js` — MAIN world, document_start: patcha `HTMLCanvasElement.prototype.getContext`
  para forçar `preserveDrawingBuffer: true` em WebGL (necessário para ler
  pixels do canvas do jogo).
- `content.js` — isolated world: overlay canvas, painel flutuante,
  calibração, detecção BFS de blobs, geometria ghost ball, render loop via RAF.
- `popup.html/js` — toggle ligado ao `chrome.storage.local` e sendMessage ao
  content script.
- `background.js` — bridge de mensagens.
- `overlay.css` — estilos do painel.
- `icons/` — 16/48/128 PNG gerados via PIL.

## O que foi implementado (2026-02)
- Estrutura completa da extensão MV3.
- Patch WebGL preserveDrawingBuffer.
- Overlay sincronizado com o canvas do jogo (DPR-aware).
- Painel flutuante arrastável com steps visuais (1..4).
- Calibração de 4 cantos + derivação das 6 caçapas.
- Seleção manual de branca/alvo/caçapa com snap em bolas detectadas/caçapas.
- Detecção automática via color-distance + flood-fill BFS, filtrada por
  área e razão de aspecto; destaca a bola mais "branca" como taco.
- Render: polígono da mesa, caçapas, bolas detectadas, ghost ball, linha
  de mira (verde tracejada) e trajetória da bola alvo até a caçapa (amarela).
- Persistência de calibração + raio no `chrome.storage.local`.
- README com passo-a-passo de instalação e uso.
- ZIP disponível em `/app/sinucada-aim-extension.zip`.

## Backlog (P1/P2)
- P1: Calibração por 6 cliques diretos nas caçapas (ao invés de 4 cantos).
- P1: Sugerir a **melhor caçapa automaticamente** após selecionar branca +
  alvo (menor ângulo de corte entre todas as 6, ponderado por obstruções).
- P1: Linha tracejada que mostra o ângulo de corte em graus.
- P2: Detecção contínua em loop (rastreio em tempo real enquanto a bola se move).
- P2: Considerar obstrução por outras bolas entre ghost ball e caçapa.
- P2: Detecção do "ângulo de tacada" pelo vetor do taco desenhado pelo jogo.
- P2: Suporte a replays/watch mode com varredura do timeline.
- P2: Ícone da extensão mais polido, modo escuro/claro.

## Testing
- Linters JS ok em todos os arquivos.
- Teste funcional exige instalação real no Chrome + conta Sinucada logada
  (não reproduzível no ambiente headless da plataforma). O usuário precisa
  carregar a extensão em `chrome://extensions` (modo dev) e testar em uma
  partida de treino / replay.

## Próximos passos
1. Usuário instala a extensão e faz um teste em replay (/watch/...).
2. Ajustar raio padrão e threshold de detecção conforme feedback.
3. Adicionar sugestão automática da melhor caçapa (próxima iteração).
