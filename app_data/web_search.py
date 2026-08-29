from app_data.config import tavily_api
from app_data.models import Evidence
from tavily import TavilyClient
import logging

logger = logging.getLogger(__name__)

client = TavilyClient(api_key=tavily_api) if tavily_api else None


def web_search(query:str,
               search_depth: str = "basic",
               topic: str = "general") -> list[Evidence] :
    if client is None:
        logger.warning("Web search requested but TAVILY_API_KEY is not configured.")
        return []

    normalized_topic = topic if topic in {"general", "news", "finance"} else "general"
    normalized_depth = search_depth if search_depth in {"basic", "advanced"} else "basic"

    try:
        web_response = client.search(
                                    query=query,
                                    search_depth=normalized_depth,
                                    topic=normalized_topic,
                                    max_results=5,
                                    include_answer=False,
                                    include_raw_content=(normalized_depth == "advanced")
                                )

    except Exception as e:
        logger.exception("Web search failed for query: %s", query)
        raise 

    results = []
    fallback_results = []

    for result in web_response.get("results", []):
        if not result.get("content"):
            continue

        normalized_result = {
            "title": result.get("title"),
            "url": result.get("url"),
            "content": result.get("content"),
            "score": result.get("score", 0.0),
            "published_date": result.get("published_date")
        }

        fallback_results.append(normalized_result)
        if normalized_result["score"] >= 0.4:
            results.append(normalized_result)

    # Broad/contextual questions can receive useful pages below the strict
    # relevance threshold. Keep the best few rather than returning no web
    # evidence at all.
    if not results:
        results = sorted(
            fallback_results,
            key=lambda item: item["score"],
            reverse=True,
        )[:3]

    evidence = [ tavily_to_evidence(result ,query) for result in results]
    return evidence

def tavily_to_evidence(result: dict, query: str) -> Evidence:
    return Evidence(
        content=result.get("content", ""),
        source_type="web",
        source=result.get("url", ""),
        title=result.get("title"),
        url=result.get("url"),
        relevance_score=result.get("score"),
        published_date=result.get("published_date"),
        retrieval_query=query
    )

