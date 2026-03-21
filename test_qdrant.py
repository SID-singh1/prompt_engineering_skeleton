import sys
import os

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), 'backend')))

from backend.core.database import QdrantDB
from qdrant_client import QdrantClient

# Simulate app startup
client = QdrantDB.get_client()

print(f"Client type: {type(client)}")
print(f"Is it exactly QdrantClient class? {client is QdrantClient}")

if hasattr(client, 'search'):
    print("Has search method!")
else:
    print("NO search method!")

try:
    print(dir(client))
except Exception as e:
    print(e)
