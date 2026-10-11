# 10 Repositories Architecture & Evaluation Report

| # | Repo | Engine | Inferred AWS Services (Confidence) | Evidence Cited? | Diagram Valid & Complete? | Cost / Mo | RDS Engine Match | CFT Valid & Complete? | Issues Flagged |
|---|---|---|---|---|---|---|---|---|---|
| 1 | [mern-student-mgmt](https://github.com/elselif/MERN) | `llm` | S3 (high), CloudFront (high), ECS (low), DocumentDB (high) | Partial (Some no-container/unfounded) | Valid & All Nodes Present | $101.16 | N/A | Saved (Missing: DocumentDB) | ECS inferred with 'no container evidence' |
| 2 | [honours-project-system](https://github.com/davidm03/honours-project-system) | n/a | (none) | No | No (Insufficient Signal) | $0.00 | N/A | No | Insufficient signal |
| 3 | [campus-web-firebase](https://github.com/gdsc-jssstu/campUS-Web) | `llm` | S3 (high), CloudFront (high) | Yes (Real) | Valid & All Nodes Present | $15.85 | N/A | Valid & Complete | None |
| 4 | [yearbook-firebase](https://github.com/m-ehab2/Yearbook) | `llm` | S3 (high), CloudFront (high) | Yes (Real) | Valid & All Nodes Present | $15.85 | N/A | Valid & Complete | None |
| 5 | [springboot-student-backend](https://github.com/PubuduJ/student-management-system-back-end) | `llm` | ECS (low), RDS (high) | Partial (Some no-container/unfounded) | Valid & All Nodes Present | $41.39 | Yes (MySQL) | Valid & Complete | ECS inferred with 'no container evidence' |
| 6 | [springboot-student-mgmt](https://github.com/ankitkumar2020/StudentManagementSystem) | `llm` | ECS (low), ALB (medium), RDS (high) | Partial (Some no-container/unfounded) | Valid & All Nodes Present | $57.59 | Yes (MySQL) | Valid & Complete | ECS inferred with 'no container evidence' |
| 7 | [php-library-mgmt](https://github.com/freesourcecode/Library-Management-System-Project-in-PHP-with-Source-Code) | `llm` | RDS (high) | Yes (Real) | Valid & All Nodes Present | $12.24 | Label: 1 db.t3.micro MySQL instance × 720 h; source: RDS pricing page (detected: none) | Valid & Complete | None |
| 8 | [flask-placement-ml](https://github.com/saravanaganesh7/Placement_Project) | `rules-fallback` | SageMaker (high), ALB (medium), S3 (medium), CloudWatch (medium) | Yes (Real) | Valid & All Nodes Present | $38.80 | N/A | Saved (Missing: CloudWatch) | None |
| 9 | [flask-ml-deployment](https://github.com/HemanthJoseph/ML-Projects-with-Deployment) | `llm` | SageMaker (high), SQS (high) | Yes (Real) | Valid & All Nodes Present | $4.60 | N/A | Valid & Complete | None |
| 10 | [django-blog-sqlite](https://github.com/drisskhattabi6/Django-Blog-Project) | `llm` | ECS (low) | Partial (Some no-container/unfounded) | Valid & All Nodes Present | $29.15 | N/A | Saved (Missing: ) | ECS inferred with 'no container evidence' |

## Top 5 Issues (Ranked by Demo Impact)

1. **ECS Inferred Without Container Evidence**: For frameworks like Spring Boot or Express without Dockerfile or container configs, ECS is suggested with low confidence and explicitly cites `'no container evidence'`, which looks unpolished in a demo.

2. **Insufficient Signal Gate on Valid Public Repos**: Repos with atypical root structure or non-standard manifest locations (e.g. `honours-project-system`) trigger `insufficient_signal` and reject inference entirely.

3. **Static Frontend Sites Getting Full Serverless CDN Without API Integration**: Repos like `campus-web-firebase` or `yearbook-firebase` get S3 + CloudFront + Route53, while their Firebase backend integration is completely ignored or unmapped in the AWS plan.

4. **Zero AWS Services Detected on Mixed / Unrecognized Layouts**: Repos like `mern-student-mgmt` yield zero services under rules-fallback if folder nesting separates the client and server manifests beyond root detection thresholds.

5. **Default MySQL Assumption in RDS Cost Label**: When database evidence is ambiguous or non-standard, the RDS line item defaults to MySQL regardless of whether the codebase actually intended PostgreSQL or another engine.
