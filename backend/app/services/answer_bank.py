"""Seed list of common application questions the user can pre-answer.

Once the user fills these in via the dashboard, the Easy Apply driver consults
this bank BEFORE calling the LLM. The longer the user uses the tool, the less
the LLM has to guess.
"""

# Helper to keep the YOE list manageable
def _yoe(skill: str) -> tuple:
    return (f"How many years of experience do you have with {skill}?", "technical", "number", None)


# Each entry: (text, category, input_type, options_or_None)
SEED_QUESTIONS = [

    # ============== Years of experience — general ==============
    ("How many years of total professional experience do you have?", "technical", "number", None),
    ("How many years of leadership / management experience do you have?", "behavioral", "number", None),
    ("How many people have you directly managed?", "behavioral", "number", None),
    ("How many years of remote-work experience do you have?", "logistics", "number", None),

    # ============== Years of experience — backend / general langs ==============
    *[_yoe(s) for s in [
        "Python", "JavaScript", "TypeScript", "Java", "Kotlin", "Go", "Golang", "Rust",
        "C", "C++", "C#", ".NET", "Ruby", "PHP", "Scala", "Swift", "Objective-C",
        "Elixir", "Erlang", "Clojure", "Haskell", "R",
    ]],

    # ============== Frameworks / web ==============
    *[_yoe(s) for s in [
        "React", "Next.js", "Vue", "Nuxt", "Angular", "Svelte", "Solid",
        "Node.js", "Express", "NestJS",
        "Django", "Flask", "FastAPI",
        "Spring", "Spring Boot", "Hibernate",
        "Rails", "Ruby on Rails", "Laravel", "Symfony",
        "Phoenix", "ASP.NET",
        "HTML", "CSS", "Tailwind CSS",
    ]],

    # ============== Mobile ==============
    *[_yoe(s) for s in [
        "iOS development", "Android development", "React Native", "Flutter", "Xamarin",
    ]],

    # ============== DevOps / Infrastructure ==============
    *[_yoe(s) for s in [
        "Docker", "Kubernetes", "OpenShift", "Helm", "Istio",
        "Terraform", "Pulumi", "Ansible", "Chef", "Puppet", "CloudFormation",
        "AWS", "Azure", "Google Cloud Platform", "GCP", "DigitalOcean", "Heroku", "OVH",
        "Jenkins", "GitHub Actions", "GitLab CI", "CircleCI", "Azure DevOps", "ArgoCD", "Tekton",
        "Linux", "Bash", "Shell scripting", "PowerShell",
        "Git", "Mercurial",
        "Prometheus", "Grafana", "Datadog", "New Relic", "Splunk", "ELK", "Elastic Stack",
        "Nginx", "Apache", "HAProxy", "Envoy",
        "CDN", "Cloudflare",
        "SRE", "Site Reliability Engineering",
        "Networking", "TCP/IP", "DNS",
        "AppSec", "Application Security", "Penetration testing", "Security",
    ]],

    # ============== Databases / storage ==============
    *[_yoe(s) for s in [
        "SQL", "PostgreSQL", "MySQL", "MariaDB", "SQLite", "Oracle", "SQL Server", "MSSQL",
        "MongoDB", "Cassandra", "DynamoDB", "CouchDB",
        "Redis", "Memcached",
        "Elasticsearch", "OpenSearch",
        "Kafka", "RabbitMQ", "Pulsar",
        "Snowflake", "BigQuery", "Redshift", "Databricks",
        "Vector databases", "Pinecone", "Weaviate", "Qdrant", "PGVector",
    ]],

    # ============== Data / ML ==============
    *[_yoe(s) for s in [
        "Machine learning", "Deep learning",
        "PyTorch", "TensorFlow", "Keras", "JAX",
        "Hugging Face", "Transformers", "LangChain", "LlamaIndex",
        "LLMs", "Large Language Models",
        "RAG", "Retrieval-Augmented Generation",
        "Prompt engineering", "Fine-tuning",
        "MLOps", "MLflow", "Kubeflow", "Vertex AI",
        "Airflow", "Dagster", "Prefect",
        "Spark", "PySpark", "Hadoop", "Hive", "dbt",
        "Pandas", "NumPy", "scikit-learn",
        "Data engineering", "ETL", "ELT",
        "NLP", "Computer vision",
        "Statistics", "A/B testing",
    ]],

    # ============== Architecture / patterns ==============
    *[_yoe(s) for s in [
        "Microservices", "Monoliths", "Event-driven architecture",
        "REST APIs", "GraphQL", "gRPC", "WebSockets", "SOAP",
        "CI/CD",
        "TDD", "Test-driven development",
        "Agile", "Scrum", "Kanban",
        "Domain-driven design", "DDD",
    ]],

    # ============== Language proficiency (selects) ==============
    *[
        (f"How well do you speak {lang}?", "logistics", "select",
         ["Native or bilingual", "Fluent", "Professional working", "Limited working", "Elementary", "None"])
        for lang in ["English", "German", "French", "Spanish", "Italian", "Dutch",
                     "Portuguese", "Polish", "Swedish", "Norwegian", "Danish", "Finnish",
                     "Mandarin", "Cantonese", "Japanese", "Korean", "Arabic", "Russian", "Turkish", "Hindi"]
    ],
    # German wording
    *[
        (f"Wie gut beherrschen Sie {lang}?", "logistics", "select",
         ["Muttersprache", "Fließend", "Geschäftsfließend", "Konversationssicher", "Grundkenntnisse", "Gar nicht"])
        for lang in ["Deutsch", "Englisch", "Französisch", "Spanisch", "Italienisch"]
    ],

    # ============== Work authorization ==============
    ("Are you legally authorized to work in the country where this job is located?", "logistics", "radio", ["Yes", "No"]),
    ("Will you now or in the future require sponsorship for employment visa status?", "logistics", "radio", ["Yes", "No"]),
    ("Are you a citizen or permanent resident of the European Union?", "logistics", "radio", ["Yes", "No"]),
    ("Are you legally authorized to work in the United States?", "logistics", "radio", ["Yes", "No"]),
    ("Are you legally authorized to work in the United Kingdom?", "logistics", "radio", ["Yes", "No"]),
    ("Sind Sie berechtigt, in Deutschland zu arbeiten?", "logistics", "radio", ["Ja", "Nein"]),
    ("Benötigen Sie eine Arbeitserlaubnis oder ein Visum?", "logistics", "radio", ["Ja", "Nein"]),
    ("Do you currently hold a valid work permit?", "logistics", "radio", ["Yes", "No"]),
    ("Have you ever been convicted of a felony?", "logistics", "radio", ["Yes", "No"]),

    # ============== Logistics ==============
    ("What is your notice period?", "logistics", "text", None),
    ("When can you start?", "logistics", "text", None),
    ("What is your availability to start?", "logistics", "text", None),
    ("Where are you currently located?", "logistics", "text", None),
    ("Are you willing to relocate?", "logistics", "radio", ["Yes", "No"]),
    ("Are you willing to work fully on-site?", "logistics", "radio", ["Yes", "No"]),
    ("Are you willing to work fully remote?", "logistics", "radio", ["Yes", "No"]),
    ("Are you willing to work hybrid?", "logistics", "radio", ["Yes", "No"]),
    ("Are you willing to travel for work?", "logistics", "radio", ["Yes", "No"]),
    ("Are you available for on-call rotation?", "logistics", "radio", ["Yes", "No"]),
    ("Wie ist Ihre Kündigungsfrist?", "logistics", "text", None),
    ("Verfügbar ab?", "logistics", "text", None),
    ("Sind Sie bereit umzuziehen?", "logistics", "radio", ["Ja", "Nein"]),
    ("Are you currently employed?", "logistics", "radio", ["Yes", "No"]),

    # ============== Salary ==============
    ("What is your salary expectation?", "salary", "text", None),
    ("What is your annual salary expectation?", "salary", "text", None),
    ("What is your current annual salary?", "salary", "text", None),
    ("What is your minimum acceptable salary?", "salary", "text", None),
    ("What is your hourly rate?", "salary", "text", None),
    ("Wie sind Ihre Gehaltsvorstellungen?", "salary", "text", None),
    ("Wie hoch ist Ihr aktuelles Bruttojahresgehalt?", "salary", "text", None),

    # ============== Diversity / EEO / self-ID (very common in US) ==============
    ("Gender", "diversity", "select",
     ["Male", "Female", "Non-binary", "Prefer not to say"]),
    ("What is your race/ethnicity?", "diversity", "select",
     ["Asian", "Black or African American", "Hispanic or Latino", "White",
      "Native American or Alaska Native", "Native Hawaiian or Pacific Islander",
      "Two or more races", "Prefer not to say"]),
    ("Are you a veteran of the U.S. Armed Forces?", "diversity", "radio", ["Yes", "No", "Prefer not to say"]),
    ("Do you have a disability?", "diversity", "radio", ["Yes", "No", "Prefer not to say"]),
    ("Are you Hispanic or Latino?", "diversity", "radio", ["Yes", "No", "Prefer not to say"]),

    # ============== Education ==============
    ("What is the highest level of education you have completed?", "logistics", "select",
     ["High school", "Associate", "Bachelor", "Master", "PhD", "Other"]),
    ("Have you graduated from university?", "logistics", "radio", ["Yes", "No"]),
    ("What is your field of study?", "logistics", "text", None),

    # ============== Behavioral / motivation (textareas) ==============
    ("Why are you interested in this role?", "motivation", "textarea", None),
    ("Why do you want to work at our company?", "motivation", "textarea", None),
    ("Tell us about yourself.", "motivation", "textarea", None),
    ("Why are you leaving your current job?", "motivation", "textarea", None),
    ("What attracted you to this position?", "motivation", "textarea", None),
    ("What makes you the best candidate for this role?", "motivation", "textarea", None),
    ("Describe your ideal work environment.", "motivation", "textarea", None),
    ("What is your greatest professional achievement?", "behavioral", "textarea", None),
    ("What is your greatest strength?", "behavioral", "textarea", None),
    ("What is your greatest weakness?", "behavioral", "textarea", None),
    ("Tell me about a time you handled a difficult situation at work.", "behavioral", "textarea", None),
    ("Tell me about a time you led a project.", "behavioral", "textarea", None),
    ("Tell me about a time you disagreed with a manager.", "behavioral", "textarea", None),
    ("Tell me about a time you failed.", "behavioral", "textarea", None),
    ("Tell me about a recent technical challenge.", "behavioral", "textarea", None),
    ("Where do you see yourself in 5 years?", "behavioral", "textarea", None),
    ("Why should we hire you?", "behavioral", "textarea", None),
    ("Describe your management style.", "behavioral", "textarea", None),
    ("How do you handle stress and pressure?", "behavioral", "textarea", None),
    ("How do you handle constructive criticism?", "behavioral", "textarea", None),
    ("What motivates you?", "motivation", "textarea", None),

    # ============== Referrals ==============
    ("How did you hear about this position?", "logistics", "text", None),
    ("Were you referred by an employee?", "logistics", "radio", ["Yes", "No"]),
    ("If yes, by whom?", "logistics", "text", None),

    # ============== Skill self-rating (number 1-10 or 1-5) ==============
    ("On a scale of 1 to 10, how would you rate your Python skills?", "technical", "number", None),
    ("On a scale of 1 to 10, how would you rate your JavaScript skills?", "technical", "number", None),
    ("On a scale of 1 to 10, how would you rate your SQL skills?", "technical", "number", None),
    ("On a scale of 1 to 5, how would you rate your leadership skills?", "behavioral", "number", None),
    ("On a scale of 1 to 5, how would you rate your communication skills?", "behavioral", "number", None),
]
