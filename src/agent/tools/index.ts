import type { Page } from "playwright-crx";
import { LLMProvider } from "../../models/providers/types";
import { browserTab, browserWait, browserClickPoint } from "./coreTools";
import { extractWithSchema, paginateAndCollect } from "./extractionTools";
import { fillFormFromData } from "./formTools";

// Import all tools from their respective modules
import { 
  browserClick, 
  browserType, 
  browserHandleDialog 
} from "./interactionTools";
import { 
  browserPressKey, 
  browserKeyboardType 
} from "./keyboardTools";
import { 
  saveMemory, 
  lookupMemories, 
  getAllMemories, 
  deleteMemory, 
  clearAllMemories 
} from "./memoryTools";

import { 
  browserMoveMouse, 
  browserClickXY, 
  browserDrag 
} from "./mouseTools";
import { 
  browserNavigate, 
  browserWaitForNavigation, 
  browserNavigateBack, 
  browserNavigateForward 
} from "./navigationTools";

import { 
  browserGetTitle, 
  browserSnapshotDom, 
  browserQuery, 
  browserAccessibleTree, 
  browserReadText, 
  browserScreenshot 
} from "./observationTools";
import { browserObserve, browserInteractiveMap, browserClickRef, browserFillRef, browserSelectRef, browserHoverRef, browserScroll } from "./pageMapTools";
import { runProcedure } from "./procedureTools";
import { smartExtract } from "./smartExtractTool";
import { browserWaitForStability } from "./stability";
import {
  browserGetActiveTab,
  browserNavigateTab,
  browserScreenshotTab
} from "./tabContextTools";





import { 
  browserTabList, 
  browserTabNew, 
  browserTabSelect, 
  browserTabClose 
} from "./tabTools";
import { ToolFactory } from "./types";

// Re-export extraction, form, automation, and skill tools for direct use
export { extractWithSchema, paginateAndCollect, fillFormFromData, runProcedure, smartExtract };

// Export all tools
export {
  // Navigation tools
  browserNavigate,
  browserWaitForNavigation,
  browserNavigateBack,
  browserNavigateForward,
  
  // Tab context tools
  browserGetActiveTab,
  browserNavigateTab,
  browserScreenshotTab,
  
  // Interaction tools
  browserClick,
  browserType,
  browserHandleDialog,
  
  // Observation tools
  browserGetTitle,
  browserSnapshotDom,
  browserQuery,
  browserAccessibleTree,
  browserReadText,
  browserScreenshot,
  
  // Mouse tools
  browserMoveMouse,
  browserClickXY,
  browserDrag,
  
  // Keyboard tools
  browserPressKey,
  browserKeyboardType,
  
  // Tab tools
  browserTabList,
  browserTabNew,
  browserTabSelect,
  browserTabClose,
  
  // Memory tools
  saveMemory,
  lookupMemories,
  getAllMemories,
  deleteMemory,
  clearAllMemories
};

// Function to get all tools as an array
export function getAllTools(page: Page, llmProvider?: LLMProvider) {
  const tools = [
    // Navigation tools
    browserNavigate(page),
    browserWaitForNavigation(page),
    browserNavigateBack(page),
    browserNavigateForward(page),
    
    // Tab context tools
    browserGetActiveTab(page),
    browserNavigateTab(page),
    browserScreenshotTab(page),
    
    // Interaction tools
    browserClick(page),
    browserType(page),
    browserHandleDialog(page),
    
    // Observation tools
    browserGetTitle(page),
    browserSnapshotDom(page),
    browserQuery(page),
    browserAccessibleTree(page),
    browserReadText(page),
    browserScreenshot(page),
    
    // Mouse tools
    browserMoveMouse(page),
    browserClickPoint(page),
    browserDrag(page),
    
    // Keyboard tools
    browserPressKey(page),
    browserKeyboardType(page),
    
    // Tab tools
    browserTabList(page),
    browserTabNew(page),
    browserTabSelect(page),
    browserTabClose(page),
    
    // Memory tools
    saveMemory(page),
    lookupMemories(page),
    getAllMemories(page),
    deleteMemory(page),
    clearAllMemories(page),

    // Form tools
    fillFormFromData(page),

    // Procedures (recorded/saved automations)
    runProcedure(page, llmProvider),

    // Page perception and ref-based actions (core)
    browserObserve(page),
    browserInteractiveMap(page),
    browserClickRef(page),
    browserFillRef(page),
    browserSelectRef(page),
    browserHoverRef(page),
    browserScroll(page),
    browserTab(page),
    browserWait(page),
    browserWaitForStability(page),
  ];

  if (llmProvider) {
    tools.push(extractWithSchema(page, llmProvider));
    tools.push(paginateAndCollect(page, llmProvider));
    tools.push(smartExtract(page, llmProvider));
  }

  return tools;
}
