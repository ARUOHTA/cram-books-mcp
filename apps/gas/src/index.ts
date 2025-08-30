// Type definitions
type Json = Record<string, any>;
type ApiResponse = {
  ok: boolean;
  data?: any;
  error?: {
    code: string;
    message: string;
  };
};

// Configuration
const CONFIG = {
  BOOKS_FILE_ID: "YOUR_SPREADSHEET_ID_HERE", // 参考書マスターのスプレッドシートID
  BOOKS_SHEET: "参考書マスター",
};

// Helper functions
function createJsonResponse(data: Json): GoogleAppsScript.Content.TextOutput {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function createErrorResponse(code: string, message: string): ApiResponse {
  return {
    ok: false,
    error: { code, message }
  };
}

function createSuccessResponse(data: any): ApiResponse {
  return {
    ok: true,
    data
  };
}

// Main entry points
function doGet(e: GoogleAppsScript.Events.DoGet): GoogleAppsScript.Content.TextOutput {
  const op = e.parameter?.op;
  
  try {
    switch (op) {
      case "books.find":
        return createJsonResponse(booksFind(e.parameter));
      case "books.get":
        return createJsonResponse(booksGet(e.parameter));
      case "health":
        return createJsonResponse(createSuccessResponse({ status: "ok", timestamp: new Date().toISOString() }));
      default:
        return createJsonResponse(createErrorResponse("BAD_OP", `Unknown operation: ${op}`));
    }
  } catch (error) {
    console.error("Error in doGet:", error);
    return createJsonResponse(createErrorResponse("EXCEPTION", String(error)));
  }
}

function doPost(e: GoogleAppsScript.Events.DoPost): GoogleAppsScript.Content.TextOutput {
  let body: Json = {};
  
  try {
    if (e.postData?.contents) {
      body = JSON.parse(e.postData.contents);
    }
  } catch (error) {
    return createJsonResponse(createErrorResponse("INVALID_JSON", "Failed to parse request body"));
  }
  
  const op = body.op;
  
  try {
    switch (op) {
      case "books.create":
        return createJsonResponse(booksCreate(body));
      case "books.update":
        return createJsonResponse(booksUpdate(body));
      case "books.delete":
        return createJsonResponse(booksDelete(body));
      case "books.filter":
        return createJsonResponse(booksFilter(body));
      default:
        return createJsonResponse(createErrorResponse("BAD_OP", `Unknown operation: ${op}`));
    }
  } catch (error) {
    console.error("Error in doPost:", error);
    return createJsonResponse(createErrorResponse("EXCEPTION", String(error)));
  }
}

// API Operations
function booksFind(params: Record<string, string>): ApiResponse {
  const query = params.query || params.q;
  
  if (!query) {
    return createErrorResponse("BAD_INPUT", "Query parameter is required");
  }
  
  try {
    const sheet = SpreadsheetApp.openById(CONFIG.BOOKS_FILE_ID)
      .getSheetByName(CONFIG.BOOKS_SHEET);
    
    if (!sheet) {
      return createErrorResponse("SHEET_NOT_FOUND", "Books sheet not found");
    }
    
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const rows = data.slice(1);
    
    // Simple search implementation
    const results = rows
      .filter(row => row.some(cell => 
        String(cell).toLowerCase().includes(query.toLowerCase())
      ))
      .map(row => {
        const obj: Record<string, any> = {};
        headers.forEach((header, index) => {
          obj[String(header)] = row[index];
        });
        return obj;
      });
    
    return createSuccessResponse({
      query,
      count: results.length,
      results
    });
  } catch (error) {
    return createErrorResponse("SEARCH_ERROR", String(error));
  }
}

function booksGet(params: Record<string, string>): ApiResponse {
  const bookId = params.book_id || params.id;
  
  if (!bookId) {
    return createErrorResponse("BAD_INPUT", "Book ID is required");
  }
  
  try {
    const sheet = SpreadsheetApp.openById(CONFIG.BOOKS_FILE_ID)
      .getSheetByName(CONFIG.BOOKS_SHEET);
    
    if (!sheet) {
      return createErrorResponse("SHEET_NOT_FOUND", "Books sheet not found");
    }
    
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const idIndex = headers.indexOf("ID");
    
    if (idIndex === -1) {
      return createErrorResponse("COLUMN_NOT_FOUND", "ID column not found");
    }
    
    const row = data.slice(1).find(row => String(row[idIndex]) === bookId);
    
    if (!row) {
      return createErrorResponse("NOT_FOUND", `Book with ID ${bookId} not found`);
    }
    
    const book: Record<string, any> = {};
    headers.forEach((header, index) => {
      book[String(header)] = row[index];
    });
    
    return createSuccessResponse(book);
  } catch (error) {
    return createErrorResponse("GET_ERROR", String(error));
  }
}

function booksCreate(body: Json): ApiResponse {
  const { title, author, isbn, category } = body;
  
  if (!title) {
    return createErrorResponse("BAD_INPUT", "Title is required");
  }
  
  try {
    const sheet = SpreadsheetApp.openById(CONFIG.BOOKS_FILE_ID)
      .getSheetByName(CONFIG.BOOKS_SHEET);
    
    if (!sheet) {
      return createErrorResponse("SHEET_NOT_FOUND", "Books sheet not found");
    }
    
    const newId = Utilities.getUuid();
    const timestamp = new Date().toISOString();
    const newRow = [newId, title, author || "", isbn || "", category || "", timestamp, timestamp];
    
    sheet.appendRow(newRow);
    
    return createSuccessResponse({
      id: newId,
      title,
      author,
      isbn,
      category,
      created_at: timestamp,
      updated_at: timestamp
    });
  } catch (error) {
    return createErrorResponse("CREATE_ERROR", String(error));
  }
}

function booksUpdate(body: Json): ApiResponse {
  const { book_id, ...updates } = body;
  
  if (!book_id) {
    return createErrorResponse("BAD_INPUT", "Book ID is required");
  }
  
  // Implementation placeholder
  return createSuccessResponse({
    id: book_id,
    updated: true,
    message: "Update operation not yet implemented"
  });
}

function booksDelete(body: Json): ApiResponse {
  const { book_id } = body;
  
  if (!book_id) {
    return createErrorResponse("BAD_INPUT", "Book ID is required");
  }
  
  // Implementation placeholder
  return createSuccessResponse({
    id: book_id,
    deleted: true,
    message: "Delete operation not yet implemented"
  });
}

function booksFilter(body: Json): ApiResponse {
  const { filters } = body;
  
  if (!filters || typeof filters !== "object") {
    return createErrorResponse("BAD_INPUT", "Filters object is required");
  }
  
  // Implementation placeholder
  return createSuccessResponse({
    filters,
    results: [],
    message: "Filter operation not yet implemented"
  });
}