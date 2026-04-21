#====================================================================================================
# START - Testing Protocol - DO NOT EDIT OR REMOVE THIS SECTION
#====================================================================================================

# THIS SECTION CONTAINS CRITICAL TESTING INSTRUCTIONS FOR BOTH AGENTS
# BOTH MAIN_AGENT AND TESTING_AGENT MUST PRESERVE THIS ENTIRE BLOCK

# Communication Protocol:
# If the `testing_agent` is available, main agent should delegate all testing tasks to it.
#
# You have access to a file called `test_result.md`. This file contains the complete testing state
# and history, and is the primary means of communication between main and the testing agent.
#
# Main and testing agents must follow this exact format to maintain testing data. 
# The testing data must be entered in yaml format Below is the data structure:
# 
## user_problem_statement: {problem_statement}
## backend:
##   - task: "Task name"
##     implemented: true
##     working: true  # or false or "NA"
##     file: "file_path.py"
##     stuck_count: 0
##     priority: "high"  # or "medium" or "low"
##     needs_retesting: false
##     status_history:
##         -working: true  # or false or "NA"
##         -agent: "main"  # or "testing" or "user"
##         -comment: "Detailed comment about status"
##
## frontend:
##   - task: "Task name"
##     implemented: true
##     working: true  # or false or "NA"
##     file: "file_path.js"
##     stuck_count: 0
##     priority: "high"  # or "medium" or "low"
##     needs_retesting: false
##     status_history:
##         -working: true  # or false or "NA"
##         -agent: "main"  # or "testing" or "user"
##         -comment: "Detailed comment about status"
##
## metadata:
##   created_by: "main_agent"
##   version: "1.0"
##   test_sequence: 0
##   run_ui: false
##
## test_plan:
##   current_focus:
##     - "Task name 1"
##     - "Task name 2"
##   stuck_tasks:
##     - "Task name with persistent issues"
##   test_all: false
##   test_priority: "high_first"  # or "sequential" or "stuck_first"
##
## agent_communication:
##     -agent: "main"  # or "testing" or "user"
##     -message: "Communication message between agents"

# Protocol Guidelines for Main agent
#
# 1. Update Test Result File Before Testing:
#    - Main agent must always update the `test_result.md` file before calling the testing agent
#    - Add implementation details to the status_history
#    - Set `needs_retesting` to true for tasks that need testing
#    - Update the `test_plan` section to guide testing priorities
#    - Add a message to `agent_communication` explaining what you've done
#
# 2. Incorporate User Feedback:
#    - When a user provides feedback that something is or isn't working, add this information to the relevant task's status_history
#    - Update the working status based on user feedback
#    - If a user reports an issue with a task that was marked as working, increment the stuck_count
#    - Whenever user reports issue in the app, if we have testing agent and task_result.md file so find the appropriate task for that and append in status_history of that task to contain the user concern and problem as well 
#
# 3. Track Stuck Tasks:
#    - Monitor which tasks have high stuck_count values or where you are fixing same issue again and again, analyze that when you read task_result.md
#    - For persistent issues, use websearch tool to find solutions
#    - Pay special attention to tasks in the stuck_tasks list
#    - When you fix an issue with a stuck task, don't reset the stuck_count until the testing agent confirms it's working
#
# 4. Provide Context to Testing Agent:
#    - When calling the testing agent, provide clear instructions about:
#      - Which tasks need testing (reference the test_plan)
#      - Any authentication details or configuration needed
#      - Specific test scenarios to focus on
#      - Any known issues or edge cases to verify
#
# 5. Call the testing agent with specific instructions referring to test_result.md
#
# IMPORTANT: Main agent must ALWAYS update test_result.md BEFORE calling the testing agent, as it relies on this file to understand what to test next.

#====================================================================================================
# END - Testing Protocol - DO NOT EDIT OR REMOVE THIS SECTION
#====================================================================================================



#====================================================================================================
# Testing Data - Main Agent and testing sub agent both should log testing data below this section
#====================================================================================================

user_problem_statement: |
  Extensão Sinucada Aim Helper — três melhorias:
  1) Permitir carregar calibragem anterior (evitar recalibrar os 4 cantos toda vez).
  2) Eliminar o flicker da mira (piscava a cada 1.5s).
  3) O raio das bolas definido manualmente deve ficar fixo (estava sendo auto-sobrescrito).

frontend:
  - task: "Botão Carregar calibragem (reuso dos 4 cantos salvos)"
    implemented: true
    working: "NA"
    file: "extension/content.js"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: "Adicionado botão [data-testid=btn-load-calib] que lê chrome.storage.local['sinucadaAimCalibration'] e restaura corners, pockets e ballRadius sem pedir clique nos 4 cantos. Dispara detectBalls + startContinuousDetection automaticamente."

  - task: "Sem flicker durante captureVisibleTab"
    implemented: true
    working: "NA"
    file: "extension/content.js"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: "Removido o visibility:hidden do overlay durante a captura. Renderização usa apenas contornos finos (2px) que são eliminados pela erosão + filtro de fill ratio na detecção, então não contaminam as screenshots. A mira agora fica visível continuamente."

  - task: "Raio das bolas fixo quando definido pelo usuário"
    implemented: true
    working: "NA"
    file: "extension/content.js"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: "Adicionada flag state.ballRadiusManual (persistida em storage). Ativada ao arrastar o slider. A auto-calibragem de raio na runDetection só roda se !ballRadiusManual, preservando o valor definido pelo usuário (ex.: 13)."

metadata:
  created_by: "main_agent"
  version: "1.1"
  test_sequence: 0
  run_ui: false

test_plan:
  current_focus: []
  stuck_tasks: []
  test_all: false
  test_priority: "high_first"

agent_communication:
  - agent: "main"
    message: "Três fixes aplicados na extensão (extension/content.js): (1) novo botão 'Carregar calibragem' restaura os 4 cantos + caçapas + raio salvos, (2) overlay não é mais escondido durante captura → sem flicker, (3) flag ballRadiusManual impede auto-override do raio setado pelo usuário. Não é aplicação web testável via deep_testing_backend/frontend — é Chrome Extension. O usuário precisa recarregar a extensão (chrome://extensions → Reload) para validar."
  - agent: "main"
    message: "Fix de mira-invertida perto da borda: detectCueStick() agora exige que os pixels candidatos do taco estejam DENTRO do polígono calibrado da mesa (usando pointInPoly). Isso impede que o painel lateral, barras pretas, chat ou rails de madeira sejam contados como 'taco' quando a bola branca está colada a uma borda. Reduzido searchR de 12R→10R. Adicionado filtro de brilho mínimo (r+g+b >= 90) para descartar sombras profundas. Adicionado guard: se CoM fica a < 0.5R da bola branca, direção é ambígua → descarta leitura. Resultado: mira consistente mesmo com bola branca junto ao rail."
