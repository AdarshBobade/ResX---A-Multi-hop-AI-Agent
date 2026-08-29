import os
import logging
import time
from functools import wraps
from pathlib import Path

Path("logs").mkdir(parents=True, exist_ok=True)

log_level_str = os.getenv("LOG_LEVEL", "INFO").upper()
log_level = getattr(logging, log_level_str, logging.INFO)

logging.basicConfig(
    level=log_level,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler("logs/research.log", mode="a", encoding="utf-8"),
    ],
)


def timer(func):
    #Decorator to measure execution time of any function.
    @wraps(func)
    def wrapper(*args, **kwargs):

        start = time.perf_counter()
        result = func(*args, **kwargs)
        end = time.perf_counter()

        elapsed = (end - start) * 1000 
        logger = logging.getLogger(func.__module__)
        logger.info(
            f"{func.__name__} completed in {elapsed:.2f} ms"
        )

        return result
    return wrapper