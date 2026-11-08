FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
RUN useradd --uid 10001 --no-create-home whisper && mkdir /models && chown whisper /models
COPY server.py .
ENV HF_HOME=/models
USER whisper
EXPOSE 8000
CMD ["python", "server.py"]
