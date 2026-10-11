$body = '{"input": {"kind": "description", "value": "A simple React frontend with a Node.js Express backend API connected to a PostgreSQL database"}}'
$response = Invoke-WebRequest -Method Post -Uri "http://localhost:3000/api/analyze" -Body $body -ContentType "application/json" -UseBasicParsing
Write-Host $response.Content